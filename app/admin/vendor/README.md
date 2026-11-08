# QR Code Generator 2.0.4

`qrcode-generator-2.0.4.mjs` — неизменённый `dist/qrcode.mjs` из npm-пакета
[`qrcode-generator@2.0.4`](https://www.npmjs.com/package/qrcode-generator/v/2.0.4).
Исходный проект: [Kazuhiko Arase](https://github.com/kazuhikoarase/qrcode-generator).
Зависимостей нет. Загружается только на странице владельца; QR создаётся локально.

SHA-256 файла: `ea91d7118a5395289170da848b7c6758b996163bfbccf312591ab65a4911b7c0`.

## MIT License

Copyright (c) 2009 Kazuhiko Arase

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.


## XML для XLSX

`xmldom-0.9.12.mjs` — браузерная ESM-сборка [@xmldom/xmldom 0.9.12](https://github.com/xmldom/xmldom), без дополнительных runtime зависимостей. Сборка ограничена XML: HTML-режим явно отклоняется, таблица HTML-сущностей исключена. Пять стандартных XML-сущностей сохранены из закреплённого исходника; скрипт проверяет точные места преобразования. Загружается только инструментом XLSX владельца. DTD/ENTITY и любая ошибка/предупреждение парсера отклоняются до чтения ячеек; CSP не ослабляется.

Источник закреплён в package-lock.json и проверяется npm audit. Сборка: `node scripts/xlsx-vendor.mjs --write`; проверка точного совпадения входит в `npm run lint`. Esbuild 0.25.12, browser/ESM/es2022/minify/legalComments=eof. SHA-256: `3c8e46bb256f54eb8e87aca9d796063480421c5483f781a074535bbf71da1f88`. Полная лицензия — [xmldom-LICENSE.txt](xmldom-LICENSE.txt).
