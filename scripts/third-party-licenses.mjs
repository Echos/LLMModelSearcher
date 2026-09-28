// 配布物に同梱する第三者ライセンス告知 (THIRD_PARTY_LICENSES.md) を生成する。
// npmの本番依存とCargoの依存 (全ターゲット) のライセンス本文を集め、同一本文はまとめて出力する。
// 使い方: node scripts/third-party-licenses.mjs

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const LICENSE_FILE = /^(licen[cs]e|copying|notice)([-_.].*)?$/i;
const FENCE = "```";

// ライセンスファイルを同梱していないパッケージのため、SPDX識別子ごとの標準本文を集める
const standardTexts = new Map();

function licenseTexts(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => LICENSE_FILE.test(f))
    .sort()
    .map((f) => {
      const text = readFileSync(join(dir, f), "utf8").replace(/\r\n/g, "\n").trim();
      if (/Apache License\s+Version 2\.0/.test(text) && !standardTexts.has("Apache-2.0")) {
        standardTexts.set("Apache-2.0", text);
      }
      if (/Mozilla Public License Version 2\.0/.test(text) && !standardTexts.has("MPL-2.0")) {
        standardTexts.set("MPL-2.0", text);
      }
      return text;
    })
    .filter(Boolean);
}

const GENERIC = {
  MIT: `MIT License

Copyright (c) the respective authors of the package

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
SOFTWARE.`,
  "BSD-3-Clause": `BSD 3-Clause License

Copyright (c) the respective authors of the package

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.
3. Neither the name of the copyright holder nor the names of its
   contributors may be used to endorse or promote products derived from
   this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.`,
  Zlib: `zlib License

Copyright (c) the respective authors of the package

This software is provided 'as-is', without any express or implied
warranty. In no event will the authors be held liable for any damages
arising from the use of this software.

Permission is granted to anyone to use this software for any purpose,
including commercial applications, and to alter it and redistribute it
freely, subject to the following restrictions:

1. The origin of this software must not be misrepresented; you must not
   claim that you wrote the original software. If you use this software
   in a product, an acknowledgment in the product documentation would be
   appreciated but is not required.
2. Altered source versions must be plainly marked as such, and must not be
   misrepresented as being the original software.
3. This notice may not be removed or altered from any source distribution.`,
};

const entries = [];

// npm (devDependencies は配布物に含まれないため除外)
const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
for (const [path, p] of Object.entries(lock.packages)) {
  if (!path || p.dev) continue;
  const pj = join(path, "package.json");
  const pkg = existsSync(pj) ? JSON.parse(readFileSync(pj, "utf8")) : {};
  entries.push({
    name: path.replace(/^.*node_modules\//, ""),
    version: p.version ?? pkg.version,
    license: p.license ?? pkg.license ?? "UNKNOWN",
    texts: licenseTexts(path),
  });
}

// Cargo (Windows/macOS/Linux の全ターゲットを含む)
const meta = JSON.parse(
  execFileSync("cargo", ["metadata", "--format-version", "1", "--locked"], {
    cwd: "src-tauri",
    maxBuffer: 256 * 1024 * 1024,
  }).toString(),
);
const used = new Set(meta.resolve.nodes.map((n) => n.id));
for (const p of meta.packages) {
  if (!used.has(p.id) || p.source == null) continue;
  entries.push({
    name: p.name,
    version: p.version,
    license: p.license ?? "UNKNOWN",
    texts: licenseTexts(dirname(p.manifest_path)),
  });
}

// 同一のライセンス本文を持つパッケージをまとめる
const groups = new Map();
for (const e of entries) {
  const key = e.texts.length
    ? e.texts.join("\n\n---\n\n")
    : `This package does not include a license file. It is licensed under: ${e.license}\n` +
      `The standard text of that license is included in the "Standard license texts" section at the end of this file.`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(e);
}

const seen = new Set();
let out = "# Third-Party Licenses\n\n";
out += "LLM Model Searcher is distributed with the following third-party software.\n";
out += "Each section lists the packages followed by their license text.\n\n";
out += `Total packages: ${entries.length}\n\n`;
for (const [text, pkgs] of [...groups.entries()].sort((a, b) => b[1].length - a[1].length)) {
  const names = pkgs
    .map((p) => `${p.name} ${p.version} (${p.license})`)
    .filter((n) => (seen.has(n) ? false : (seen.add(n), true)))
    .sort();
  if (names.length === 0) continue;
  out += "## " + names.slice(0, 3).join(", ") + (names.length > 3 ? ` and ${names.length - 3} more` : "") + "\n\n";
  out += names.map((n) => `- ${n}`).join("\n") + "\n\n";
  out += `${FENCE}text\n${text.replaceAll(FENCE, "'''")}\n${FENCE}\n\n`;
}

out += "## Standard license texts\n\n";
out += "Applies to the packages above that do not include their own license file.\n\n";
for (const [id, text] of [
  ["MIT", GENERIC.MIT],
  ["Apache-2.0", standardTexts.get("Apache-2.0")],
  ["MPL-2.0", standardTexts.get("MPL-2.0")],
  ["BSD-3-Clause", GENERIC["BSD-3-Clause"]],
  ["Zlib", GENERIC.Zlib],
]) {
  if (!text) throw new Error(`standard text for ${id} not found`);
  out += `### ${id}\n\n${FENCE}text\n${text}\n${FENCE}\n\n`;
}

out += "## Source code of MPL-2.0 components\n\n";
out += "The MPL-2.0 licensed components are used without modification. Their source code is available at:\n\n";
out +=
  entries
    .filter((e) => /MPL-2\.0/.test(e.license))
    .map((e) => `- https://crates.io/crates/${e.name}/${e.version}`)
    .join("\n") + "\n";

writeFileSync("THIRD_PARTY_LICENSES.md", out);
console.log(
  `THIRD_PARTY_LICENSES.md: ${entries.length} packages, ${groups.size} distinct license texts, ${(out.length / 1024).toFixed(0)} KB`,
);
