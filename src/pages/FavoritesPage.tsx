import { Search, Star } from "lucide-react";
import { useApp } from "../AppContext";
import { relativeTime } from "../lib/format";

export function FavoritesPage() {
  const { t, lang, user, openModel, toggleFavorite, clearHistory, navigate } = useApp();
  return (
    <div className="page two-col">
      <section>
        <h2>{t("fav.title")}</h2>
        {user.favorites.length === 0 && <p className="empty">{t("fav.empty")}</p>}
        <ul className="plain list">
          {user.favorites.map((f) => (
            <li key={f.repoId}>
              <button className="icon-btn active" onClick={() => toggleFavorite(f.repoId)} title={t("detail.unfavorite")}>
                <Star size={16} fill="currentColor" />
              </button>
              <button className="link" onClick={() => openModel(f.repoId)}>
                {f.repoId}
              </button>
              <span className="muted small">{t("fav.added", { time: relativeTime(f.addedAt, lang) })}</span>
            </li>
          ))}
        </ul>
      </section>
      <section>
        <div className="page-header">
          <h2>{t("hist.title")}</h2>
          <button className="btn small" disabled={user.history.length === 0} onClick={() => clearHistory()}>
            {t("hist.clear")}
          </button>
        </div>
        {user.history.length === 0 && <p className="empty">{t("hist.empty")}</p>}
        <ul className="plain list">
          {user.history.map((h, i) => {
            const f = h.filters as { formats?: string[]; sort?: string; task?: string };
            return (
              <li key={`${h.query}-${i}`}>
                <button
                  className="icon-btn"
                  title={t("hist.run")}
                  onClick={() => navigate("search", { filters: h.filters })}
                >
                  <Search size={16} />
                </button>
                <strong>{h.query}</strong>
                <span className="muted small">
                  {[f.formats?.join("/"), f.sort && t(`search.sort.${f.sort}` as "search.sort.downloads"), f.task]
                    .filter(Boolean)
                    .join(" ・ ")}{" "}
                  ・ {relativeTime(h.searchedAt, lang)}
                </span>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
