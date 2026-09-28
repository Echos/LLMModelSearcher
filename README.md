# LLM Model Searcher

LM Studio のモデル検索機能を切り出し、モデルの**検索・推奨・ダウンロード・追跡**に特化したデスクトップアプリです。
実行中のマシンのスペック (GPU / VRAM / RAM / メモリ帯域) を検出し、各モデル・各量子化がこのPCで動くか、どの程度の速度が出るかを推定します。

Tauri v2 (Rust) + React + TypeScript 製で、Windows / macOS / Linux に対応します。

## 主な機能

| 画面 | 内容 |
|---|---|
| 検索 | Hugging Face 全体を検索 (GGUF / MLX / safetensors)。並び順・タスク・サイズ・「このPCで動くもののみ」で絞り込み。モデルの特性をアイコン表示し、特性でも絞り込める |
| おすすめ | 用途別 (汎用チャット / コーディング / 推論 / 画像入力 / 日本語 / 埋め込み) に、このPCで快適に動くモデルと最適な量子化を提示 |
| トレンド・新着 | トレンド順・公開順・更新順の一覧を適合度付きで表示 |
| モデル詳細 | 量子化ごとの必要メモリ (重み + KVキャッシュ + その他)・適合度・推定 tok/s、おすすめの量子化、ダウンロード、README、量子化版・派生モデルの一覧 |
| ライブラリ | 保存済みモデルの一覧・容量・削除。公開からの経過期間、ファイル更新、`new_version`、後継モデル (推定)、保存後に公開された派生モデルを追跡 |
| ダウンロード | キュー、同時ダウンロード数の制御、一時停止・再開 (Range によるレジューム、再起動後も継続)、SHA256 検証 |
| お気に入り・履歴 | お気に入りモデルと検索条件の履歴 (再検索可) |
| システム | 検出したハードウェアと、推定に使う値 (使用可能VRAM・帯域) |
| 設定 | 保存先、言語 (日本語/英語)、テーマ、推定条件、ハードウェア値の上書き、Hugging Face トークン |

### モデルの特性アイコン

| 特性 | 判定方法 |
|---|---|
| 画像入力 | pipeline_tag (`image-text-to-text`)、タグ、GGUFアーキテクチャ名 (qwen3vl, gemma3, mistral3 等)、モデル名、mmproj ファイルの有無 (詳細画面) |
| ツール呼び出し | GGUF のチャットテンプレートに `tools` / `tool_call` を含むか、タグ |
| 推論・思考 | チャットテンプレートの `<think>` / `enable_thinking`、タグ、モデル名 |
| コーディング / 日本語 / 埋め込み / 音声入力 / 検閲解除版 | タグ・言語タグ・pipeline_tag・モデル名 |
| 多言語 | 英語以外の言語タグが5つ以上 |
| 長文脈 | 最大コンテキスト 128K 以上 |
| MoE | 名前の `A3B` 形式、アーキテクチャ、GGUF の expert 数 |

「LLM以外を除く」(既定で有効) は画像生成・音声合成などの pipeline_tag を持つモデルを一覧から除外します。

## 保存先の構成

設定で指定したディレクトリの下に、LM Studio と同じ構成で保存します。

```
<保存先>/<公開者>/<リポジトリ>/<ファイル>
例: D:\Models\unsloth\Qwen3-8B-GGUF\Qwen3-8B-Q4_K_M.gguf
```

ダウンロード中のファイルは `<ファイル>.part` として保存され、完了・検証後にリネームされます。

## 適合度・速度の推定方法

```mermaid
flowchart LR
  HW[ハードウェア検出<br/>nvidia-smi / レジストリ / sysctl / sysfs] --> P[マシンプロファイル<br/>使用可能VRAM・GPU帯域・RAM帯域]
  M[モデル情報<br/>HF API] --> W[重みサイズ<br/>実ファイル or パラメータ数×bpw]
  G[GGUFヘッダ部分取得<br/>or config.json] --> KV[KVキャッシュ/トークン]
  P --> F{必要メモリ = 重み + KV×コンテキスト長 + オーバーヘッド}
  W --> F
  KV --> F
  F -->|VRAMに収まる| FG[GPUに全て収まる]
  F -->|VRAM+RAM| PT[一部CPUへオフロード]
  F -->|RAMのみ| CPU[CPUのみ]
  F -->|不足| NF[メモリ不足]
  FG & PT & CPU --> S[推定 tok/s = 実効帯域 ÷ 1トークンあたりの読み出し量<br/>MoEはアクティブパラメータ分のみ]
```

- **KVキャッシュ**: GGUF はファイル先頭のメタデータだけを Range リクエストで取得して層数・KVヘッド数から算出、safetensors / MLX は `config.json` から算出します。取得できない場合はパラメータ数から推定します。
- **GPU帯域**: GPU名から参考値の表 (`src/lib/bandwidth.ts`) を引きます。未知のGPUや実測と異なる場合は設定で上書きできます。
- **Apple Silicon**: 統合メモリのうち macOS が既定で GPU に割り当てる上限 (約 2/3〜3/4) を使用可能VRAMとします。MLX 形式は Apple Silicon でのみ「対応」になります。
- 推定値は目安です。実際の速度はランタイム・設定・プロンプト長により変わります。

## アーキテクチャ

```mermaid
flowchart TB
  subgraph Frontend [React + TypeScript]
    Pages[pages/*] --> Ctx[AppContext<br/>状態・i18n・定期更新確認]
    Pages --> Lib[lib/<br/>estimate / quant / capabilities / recommend / hfmodel]
  end
  subgraph Backend [Rust / Tauri]
    Cmd[lib.rs コマンド] --> HF[hf.rs<br/>HF APIプロキシ・GGUFヘッダ取得]
    Cmd --> DL[download.rs<br/>キュー・レジューム・SHA256]
    Cmd --> LIB[library.rs<br/>走査・削除・追跡]
    Cmd --> HWD[hardware.rs]
    Cmd --> ST[store.rs / secrets.rs<br/>JSON永続化・OS資格情報ストア]
  end
  Ctx -- invoke / event --> Cmd
  HF --> HUB[(huggingface.co)]
  DL --> HUB
```

アプリの状態はアプリデータディレクトリ (Windows: `%APPDATA%\com.echos.llmmodelsearcher`) に保存します。

| ファイル | 内容 |
|---|---|
| `state.json` | 設定・お気に入り・検索履歴 |
| `library.json` | ダウンロード記録 (リビジョン・LFSハッシュ) と追跡結果 |
| `downloads.json` | ダウンロードキュー (再起動後の再開用) |

Hugging Face トークンは OS の資格情報ストア (Windows 資格情報マネージャ / macOS キーチェーン / Linux Secret Service) に保存します。

## 開発

必要なもの: Node.js 20+、Rust (stable)、[Tauri の前提パッケージ](https://tauri.app/start/prerequisites/)

```bash
npm install
```

```bash
npm run tauri dev
```

```bash
npm run tauri build
```

テスト:

```bash
npm test
```

```bash
cd src-tauri && cargo test
```

Hugging Face に実際に接続する結合テスト (GGUFヘッダ取得・追跡) は `#[ignore]` 付きです。

```bash
cd src-tauri && cargo test -- --ignored
```
