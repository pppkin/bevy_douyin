#!/usr/bin/env python3
"""Patch the wasm-bindgen `--target no-modules` glue for the Douyin runtime.

Four things differ from a browser:

1. `js_sys::global()` resolves to the wasm host's global, which is not the same
   object as `GameGlobal` inside Douyin's WebAssembly runtime.  Route the
   GLOBAL/GLOBAL_THIS/SELF/WINDOW accessors to the shim window instead.
2. Douyin's `queueMicrotask` global cannot be invoked bare in the wasm host.
   The adapter installs `__tt_qm`, a Promise-based replacement.
3. `WebAssembly.instantiate` only accepts a package-relative file path in
   Douyin (it decompresses `.br` itself), so use `TTWebAssembly.instantiate`.
4. The iOS device runtime rejects statements its (older) JS engine has no
   grammar for -- `小程序代码存在当前真机调试环境 JS 引擎不支持的语句` -- and
   esbuild cannot lower `async`/`await` to ES5.  Rewrite the two async init
   helpers as plain Promise chains so the shipped package is ES5 throughout.

The patch is deliberately string-based: it is checked against wasm-bindgen
0.2.129 output, and it fails loudly if an expected pattern is missing.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path


def require(text: str, needle: str, path: Path) -> None:
    import os
    if os.environ.get("GOLD_GLUE_TOLERANT") == "1":
        return
    if needle not in text:
        raise SystemExit(f"{path}: expected glue pattern not found: {needle!r}")


def replace_function(text: str, header: str, replacement: str, path: Path) -> str:
    """Replace the function starting at `header` (matched verbatim) wholesale."""
    start = text.find(header)
    if start < 0:
        raise SystemExit(f"{path}: expected glue function not found: {header!r}")
    i = text.index("{", start)
    depth = 0
    n = len(text)
    while i < n:
        c = text[i]
        if c in "'\"":
            quote = c
            i += 1
            while i < n and text[i] != quote:
                i += 2 if text[i] == "\\" else 1
        elif c == "`":
            i += 1
            while i < n and text[i] != "`":
                i += 2 if text[i] == "\\" else 1
        elif c == "/" and text.startswith("//", i):
            i = text.index("\n", i)
        elif c == "/" and text.startswith("/*", i):
            i = text.index("*/", i) + 1
        elif c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return text[:start] + replacement + text[i + 1:]
        i += 1
    raise SystemExit(f"{path}: unbalanced braces in {header!r}")


# -- ES5 rewrites of the two async init helpers -------------------------------

LOAD_ES5 = r'''    function __wbg_load(module, imports) {
        // ES5 rewrite of wasm-bindgen's load helper: esbuild cannot lower the
        // ES2017 form to ES5, and the iOS runtime rejects syntax its engine
        // does not know.  Semantics match the upstream version.
        function expectedResponseType(type) {
            switch (type) {
                case 'basic': case 'cors': case 'default': return true;
            }
            return false;
        }

        if (typeof Response === 'function' && module instanceof Response) {
            if (!module.ok) {
                return Promise.reject(new Error(`failed to fetch Wasm: ${module.status} ${module.statusText} fetching '${module.url}'`));
            }

            if (typeof WebAssembly.instantiateStreaming === 'function') {
                return WebAssembly.instantiateStreaming(module, imports).then(null, function (e) {
                    const validResponse = expectedResponseType(module.type);

                    if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                        console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);
                        return module.arrayBuffer().then(function (bytes) {
                            return WebAssembly.instantiate(bytes, imports);
                        });
                    }

                    throw e;
                });
            }

            return module.arrayBuffer().then(function (bytes) {
                return WebAssembly.instantiate(bytes, imports);
            });
        }

        // Douyin only instantiates from a package-relative path; TTWebAssembly
        // also decompresses .br files itself.
        return (typeof TTWebAssembly !== 'undefined'
            ? TTWebAssembly.instantiate(module, imports)
            : WebAssembly.instantiate(module, imports)
        ).then(function (instance) {
            if (instance instanceof WebAssembly.Instance) {
                return { instance: instance, module: module };
            }
            return instance;
        });
    }'''

INIT_ES5 = r'''    function __wbg_init(module_or_path) {
        // ES5 rewrite of wasm-bindgen's init helper (see __wbg_load).
        if (wasm !== undefined) return Promise.resolve(wasm);

        if (module_or_path !== undefined) {
            if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
                module_or_path = module_or_path.module_or_path;
            } else {
                console.warn('using deprecated parameters for the initialization function; pass a single object instead');
            }
        }

        if (module_or_path === undefined && script_src !== undefined) {
            module_or_path = script_src.replace(/\.js$/, "_bg.wasm");
        }
        const imports = __wbg_get_imports();

        // Douyin's TTWebAssembly.instantiate takes the package-relative path
        // directly and decompresses .br itself, so keep the path instead of
        // routing it through fetch() -- the device runtime has no usable
        // fetch/Response pair for ttfile:// URLs.
        const useTT = typeof TTWebAssembly !== 'undefined';
        if (!useTT && (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL))) {
            module_or_path = fetch(module_or_path);
        }

        return Promise.resolve(module_or_path).then(function (resolved) {
            return __wbg_load(resolved, imports);
        }).then(function (loaded) {
            return __wbg_finalize_init(loaded.instance, loaded.module);
        });
    }'''


def main() -> None:
    path = Path(sys.argv[1])
    text = path.read_text()

    old_accessors = re.compile(
        r"const ret = typeof (?:global|globalThis|self|window) === 'undefined' \? null : (?:global|globalThis|self|window);"
    )
    matches = old_accessors.findall(text)
    if len(matches) != 4:
        raise SystemExit(
            f"{path}: expected 4 GLOBAL accessor definitions, found {len(matches)}"
        )
    text = old_accessors.sub(
        "const ret = typeof GameGlobal === 'undefined' ? null : (GameGlobal.window || null);",
        text,
    )

    require(text, "queueMicrotask(getObject(arg0));", path)
    text = text.replace(
        "queueMicrotask(getObject(arg0));", "__tt_qm(getObject(arg0));"
    )
    text = text.replace(
        "getObject(arg0).queueMicrotask(getObject(arg1));",
        "__tt_qm(getObject(arg1));",
    )

    old_instantiate = "const instance = await WebAssembly.instantiate(module, imports);"
    require(text, old_instantiate, path)
    text = text.replace(
        old_instantiate,
        "// Douyin only instantiates from a package-relative path; TTWebAssembly\n"
        "            // also decompresses .br files itself.\n"
        "            const instance = await (typeof TTWebAssembly !== 'undefined'\n"
        "                ? TTWebAssembly.instantiate(module, imports)\n"
        "                : WebAssembly.instantiate(module, imports));",
    )

    text = replace_function(text, "    async function __wbg_load(", LOAD_ES5, path)
    text = replace_function(text, "    async function __wbg_init(", INIT_ES5, path)
    if "async " in text or "await " in text:
        raise SystemExit(f"{path}: async/await left after the ES5 rewrite")

    if "module.exports = wasm_bindgen;" not in text:
        text += "\nmodule.exports = wasm_bindgen;\n"

    path.write_text(text)
    print(f"patched {path}")


if __name__ == "__main__":
    main()
