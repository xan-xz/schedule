import { qrcode } from "./vendor/qrcode-generator-2.0.4.mjs";

/** Never send an enrollment URI to a network image/QR service. */
export function enrollmentQr(uri) {
  const parsed = new URL(uri);
  if (
    parsed.protocol !== "otpauth:" ||
    parsed.hostname !== "totp" ||
    !parsed.searchParams.get("secret") ||
    uri.length > 2048
  )
    throw Error("Invalid enrollment");
  qrcode.stringToBytes = (text) => [...new TextEncoder().encode(text)];
  const qr = qrcode(0, "M");
  qr.addData(uri, "Byte");
  qr.make();
  const size = qr.getModuleCount();
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${size + 8} ${size + 8}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "QR-код для приложения аутентификации");
  svg.setAttribute("class", "owner-qr");
  const background = document.createElementNS(ns, "rect");
  background.setAttribute("width", String(size + 8));
  background.setAttribute("height", String(size + 8));
  background.setAttribute("fill", "#fff");
  const path = document.createElementNS(ns, "path");
  let geometry = "";
  for (let row = 0; row < size; row++)
    for (let col = 0; col < size; col++)
      if (qr.isDark(row, col)) geometry += `M${col + 4},${row + 4}h1v1h-1z`;
  path.setAttribute("d", geometry);
  path.setAttribute("fill", "#000");
  svg.append(background, path);
  return svg;
}
