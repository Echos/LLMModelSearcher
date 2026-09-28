# CLAUDE.md

## リポジトリ概要

Hugging Face のLLMモデル検索・推奨・ダウンロード・追跡を行う Tauri v2 (Rust) + React + TypeScript のデスクトップアプリ。Windows / macOS / Linux 対応。仕様と推定方法は README.md を参照。

## よく使うコマンド

```bash
npm run tauri dev          # 開発起動 (Vite :1420 + Rust)
npx tsc --noEmit           # 型チェック
npm test                   # フロントエンドのユニットテスト (vitest)
cd src-tauri && cargo test # Rustのユニットテスト
cd src-tauri && cargo test -- --ignored  # HFに接続する結合テスト
cd src-tauri && cargo clippy --all-targets
```

## 構成と責務

- `src-tauri/src/`
  - `lib.rs`: Tauriコマンドと共有状態 `Core`
  - `hf.rs`: HF APIプロキシ。トークンはここで付与する。`model_arch` はGGUFヘッダをRangeで部分取得 (`gguf.rs` で解析) または `config.json` を読む
  - `download.rs`: キュー (`pump` で並列数制御)、`.part` へのレジューム、SHA256検証、`downloads.json` に永続化
  - `library.rs`: `<保存先>/<公開者>/<リポジトリ>` の走査・削除・追跡 (更新/new_version/後継/派生)
  - `hardware.rs`: OS別のGPU/メモリ検出 (Windowsはnvidia-smi + レジストリ `qwMemorySize`)
  - `paths.rs`: repo id・相対パスの検証。ファイル操作は必ずここを通す
- `src/lib/`: 推定ロジックは純粋関数に保ち、`lib.test.ts` でテストする
  - `estimate.ts`: 適合度・tok/s推定、量子化選択 (`pickBestQuant`)
  - `capabilities.ts`: 特性 (画像入力・ツール等) の判定
  - `bandwidth.ts`: GPU帯域の参考値表 (具体的な名前を先に並べる)
- `src/i18n/`: `ja.ts` がキーの正本。`en.ts` は `Dict` 型で同じキーを強制される

## MCPサーバー

- `src-tauri/src/mcp.rs`: axumで `127.0.0.1:<port>/mcp` を待ち受け (Streamable HTTP, JSON応答のみ)。`initialize`/`ping` はRustで応答し、`tools/list`/`tools/call` は `mcp-request` イベントでWebViewへ転送、`mcp_respond` コマンドで結果を受け取る
- `src/mcp/tools.ts`: ツール定義と実装。推定ロジックはGUIと共通 (`lib/analyze.ts` など) にし、MCP用に別実装しない
- 設定変更時は `mcp::reconcile` でサーバーを起動・停止・ポート変更する
- ダウンロードツールは `mcpAllowDownload` が有効なときだけ `tools/list` に出す。削除・設定変更のツールは提供しない

## ライセンス・リリース

- 依存を追加・更新したら `npm run licenses` で `THIRD_PARTY_LICENSES.md` を再生成してコミットする (配布物に同梱される)
- GPL系などコピーレフトの依存を追加しない。追加前にライセンスを確認する
- `v*` タグのpushで `.github/workflows/release.yml` が全OSのパッケージを下書きリリースに添付する

## 注意事項

- HF API のレスポンスはRust側でパススルーし、TS側 (`hfmodel.ts` の `toSummary`) で正規化する。フィールドを追加したら両方の型を確認する
- Claude Code のBashサンドボックスから `tauri dev` を起動するとネットワークが遮断され、HFへの接続が `os error 11001` (DNS失敗) になる。動作確認はサンドボックス外で起動する
- Vite のファイル監視が編集を取りこぼし、古いモジュールが配信され続けることがある (HMRログに対象ファイルが出ない)。挙動が不自然なら `tauri dev` ごと再起動する。WebViewのconsoleエラーは `tauri dev` の出力に転送される
- Rust の `Command` 起動時はWindowsで `CREATE_NO_WINDOW` を付け、コンソールウィンドウを出さない
