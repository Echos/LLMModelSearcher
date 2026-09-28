import { openUrl } from "@tauri-apps/plugin-opener";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

function stripFrontMatter(md: string): string {
  return md.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
}

/** HFのREADMEを表示する。生HTMLは描画せず、リンクは外部ブラウザで開く */
export function Markdown({ source, repoId }: { source: string; repoId: string }) {
  const resolve = (url: string | undefined, kind: "blob" | "resolve") => {
    if (!url) return undefined;
    if (/^(https?:|mailto:|#)/i.test(url)) return url;
    return `https://huggingface.co/${repoId}/${kind}/main/${url.replace(/^\.?\//, "")}`;
  };
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => {
            const url = resolve(href, "blob");
            return (
              <a
                href={url}
                onClick={(e) => {
                  e.preventDefault();
                  if (url && /^https?:/i.test(url)) openUrl(url);
                }}
              >
                {children}
              </a>
            );
          },
          img: ({ src, alt }) => {
            const url = resolve(typeof src === "string" ? src : undefined, "resolve");
            return url && /^https:/i.test(url) ? <img src={url} alt={alt ?? ""} loading="lazy" /> : null;
          },
        }}
      >
        {stripFrontMatter(source)}
      </ReactMarkdown>
    </div>
  );
}
