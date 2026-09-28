import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { AppProvider } from "./AppContext";
import { api, errorMessage } from "./lib/api";
import "./styles.css";

const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);

api
  .getUserData()
  .then((data) =>
    root.render(
      <React.StrictMode>
        <AppProvider initial={data}>
          <App />
        </AppProvider>
      </React.StrictMode>,
    ),
  )
  .catch((e) => root.render(<pre className="fatal">{errorMessage(e)}</pre>));
