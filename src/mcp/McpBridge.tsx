import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef } from "react";
import { useApp } from "../AppContext";
import { callTool, listTools, type McpContext } from "./tools";

interface ForwardRequest {
  id: number;
  method: string;
  params: { name?: string; arguments?: Record<string, unknown> };
}

/** Rust側MCPサーバーから転送されたリクエストを処理し、結果を返す (描画なし) */
export function McpBridge() {
  const { settings, hw, profile, library, downloads, user, notify, t } = useApp();
  const ctxRef = useRef<McpContext | null>(null);
  ctxRef.current = { settings, hw, profile, library, downloads, favorites: user.favorites };
  const notifyRef = useRef(notify);
  notifyRef.current = notify;
  const tRef = useRef(t);
  tRef.current = t;

  useEffect(() => {
    const unlisten = listen<ForwardRequest>("mcp-request", async (e) => {
      const { id, method, params } = e.payload;
      const ctx = ctxRef.current!;
      try {
        let result: unknown;
        if (method === "tools/list") {
          result = { tools: listTools(ctx) };
        } else if (method === "tools/call") {
          const name = params.name ?? "";
          result = await callTool(name, params.arguments ?? {}, ctx);
          if (name === "download_model" && !(result as { isError?: boolean }).isError) {
            notifyRef.current(tRef.current("mcp.downloadStarted", { repo: String(params.arguments?.repo_id ?? "") }));
          }
        } else {
          throw new Error(`unsupported method: ${method}`);
        }
        await invoke("mcp_respond", { id, result, error: null });
      } catch (err) {
        await invoke("mcp_respond", { id, result: null, error: err instanceof Error ? err.message : String(err) });
      }
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  return null;
}
