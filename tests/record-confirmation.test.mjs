import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { releaseAssets } from "../scripts/locked-release.mjs";

test("the real recording CLI uses one acknowledged ID while every tag/list index stays stale", async (t) => {
  const directory = await mkdtemp(
    resolve(process.cwd(), ".test-record-confirmation-"),
  );
  t.after(async () => {
    assert.ok(directory.startsWith(process.cwd() + sep));
    await rm(directory, { recursive: true, force: true });
  });
  const source = "a".repeat(40),
    repo = "fixture/repository",
    run = "123",
    tag = "uniflow-production-123";
  const site = resolve(directory, "site");
  await mkdir(site);
  await writeFile(resolve(site, "index.html"), "checked public shell");
  await writeFile(
    resolve(site, "release.json"),
    JSON.stringify({
      format: "uniflow-scope-v1",
      channel: "production",
      sourceRef: source,
    }),
  );
  const archivePath = resolve(directory, "production-site.tar");
  execFileSync("tar", ["-cf", archivePath, "-C", site, "."]);
  const archive = await readFile(archivePath),
    manifest = Buffer.from(
      JSON.stringify({
        format: "uniflow-production-v1",
        sourceRef: source,
        workflowRun: run,
        archiveSha256: createHash("sha256").update(archive).digest("hex"),
      }),
    );
  await writeFile(resolve(directory, "production.json"), manifest);
  const config = {
      source,
      repo,
      tag,
      assets: releaseAssets(archive, manifest),
    },
    configPath = resolve(directory, "fixture.json"),
    callsPath = resolve(directory, "calls.json"),
    preload = resolve(directory, "provider.mjs");
  await writeFile(configPath, JSON.stringify(config));
  await writeFile(
    preload,
    String.raw`
 import{createRequire,syncBuiltinESMExports}from"node:module";
 import{readFileSync,writeFileSync}from"node:fs";
 import{createHash}from"node:crypto";
 const config=JSON.parse(readFileSync(${JSON.stringify(configPath)},"utf8")),calls=[];
 const cp=createRequire(import.meta.url)("node:child_process"),nativeSpawn=cp.spawnSync,nativeExec=cp.execFileSync;
 let created=false,published=false,idReads=0,assets=[];
 const body=()=>({id:321,tag_name:config.tag,target_commitish:config.source,draft:!published,prerelease:false,immutable:published,assets});
 const response=(status,value)=>({status:status>=400?1:0,stdout:"HTTP/2.0 "+status+" Status\r\nContent-Type: application/json\r\n\r\n"+JSON.stringify(value),stderr:""});
 cp.spawnSync=(command,args,options)=>{
  if(command!=="gh")return nativeSpawn(command,args,options);
  const endpoint=args.find((arg)=>arg.startsWith("repos/")||arg.startsWith("https://uploads.github.com/"));
  const method=args.includes("--method")?args[args.indexOf("--method")+1]:"GET";
  calls.push({endpoint,method});writeFileSync(${JSON.stringify(callsPath)},JSON.stringify(calls));
  if(args[0]!=="api")throw Error("Only direct REST transport is allowed");
  if(endpoint.includes("/git/ref/tags/"))return published?response(200,{object:{type:"commit",sha:config.source}}):response(404,{message:"Not Found",status:"404"});
  if(endpoint.includes("/releases/tags/"))return response(404,{message:"Not Found",status:"404"});
  if(endpoint.endsWith("/releases?per_page=100"))return{status:0,stdout:"[[]]",stderr:""};
  if(method==="POST"&&endpoint==="repos/"+config.repo+"/releases"){
   if(created||!args.includes("draft=true")||!args.includes("target_commitish="+config.source))throw Error("Invalid or repeated create");
   created=true;return response(201,body());
  }
  if(method==="GET"&&endpoint==="repos/"+config.repo+"/releases/321"){
   idReads++;return idReads<=2?response(404,{message:"Not Found",status:"404"}):response(200,body());
  }
  if(method==="POST"&&endpoint.startsWith("https://uploads.github.com/repos/"+config.repo+"/releases/321/assets?name=")){
   const name=new URL(endpoint).searchParams.get("name"),expected=config.assets.find((item)=>item.name===name),bytes=readFileSync(args[args.indexOf("--input")+1]);
   if(!created||!expected||assets.some((item)=>item.name===name)||!args.includes("Content-Type: application/octet-stream")||!args.includes("Content-Length: "+expected.size)||expected.size!==bytes.length||expected.sha256!==createHash("sha256").update(bytes).digest("hex"))throw Error("Unverified or repeated upload");
   const asset={name,size:expected.size,digest:"sha256:"+expected.sha256,state:"uploaded"};assets.push(asset);return response(201,asset);
  }
  if(method==="PATCH"&&endpoint==="repos/"+config.repo+"/releases/321"){
   if(published||assets.length!==2||!args.includes("draft=false"))throw Error("Unsafe publication");published=true;return response(200,body());
  }
  throw Error("Unexpected fixture API request");
 };
 cp.execFileSync=(command,...args)=>{if(command==="gh")throw Error("Tag-based release commands are forbidden");return nativeExec(command,...args);};
 syncBuiltinESMExports();
 `,
  );
  const script = fileURLToPath(
    new URL("../scripts/record-production.mjs", import.meta.url),
  );
  const result = spawnSync(
    process.execPath,
    ["--import", pathToFileURL(preload).href, script, "--dir", directory],
    {
      cwd: directory,
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_SHA: source,
        GITHUB_RUN_ID: run,
        GITHUB_REPOSITORY: repo,
        GH_TOKEN: "",
        GITHUB_TOKEN: "",
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    tag,
    sourceRef: source,
    immutable: true,
    outcome: "created",
  });
  const calls = JSON.parse(await readFile(callsPath, "utf8"));
  assert.equal(
    calls.filter((c) => c.endpoint.endsWith("/releases?per_page=100")).length,
    1,
  );
  assert.equal(
    calls.filter((c) => c.endpoint.includes("/releases/tags/")).length,
    1,
  );
  assert.equal(
    calls.filter(
      (c) =>
        c.method === "POST" && c.endpoint === "repos/" + repo + "/releases",
    ).length,
    1,
  );
  assert.equal(
    calls.filter(
      (c) =>
        c.method === "POST" &&
        c.endpoint.startsWith("https://uploads.github.com/"),
    ).length,
    2,
  );
  assert.equal(calls.filter((c) => c.method === "PATCH").length, 1);
  assert.equal(
    calls.some((c) => c.method === "DELETE"),
    false,
  );
});
