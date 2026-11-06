# vendor

外部のCDNからスクリプトを読み込まないように、PDF.js のビルド済みファイルをそのまま置いています。

- `pdfjs-3.11.174/pdf.min.js`, `pdfjs-3.11.174/pdf.worker.min.js`
  - 出どころ: npm パッケージ `pdfjs-dist@3.11.174` の `build/`(jsDelivr と unpkg で同じ内容であることを確認)
  - ライセンス: Apache License 2.0(Mozilla Foundation)。ファイル先頭のライセンス表記を参照

- `wllama-3.8.1/index.js`, `wllama-3.8.1/wllama.wasm`
  - 出どころ: npm パッケージ `@wllama/wllama@3.8.1` の `esm/index.js` と `esm/wasm/wllama.wasm`(jsDelivr と unpkg で同じ内容であることを確認)
  - 用途: 端末内の翻訳(PLaMo 3 Translate)を llama.cpp の WebAssembly 版で動かす
  - ライセンス: MIT(`wllama-3.8.1/LICENSE`)
