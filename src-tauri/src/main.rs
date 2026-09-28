// リリースビルドでWindowsのコンソールウィンドウを表示しない
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    llm_model_searcher_lib::run()
}
