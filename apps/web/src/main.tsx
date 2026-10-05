import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import { ApiProvider } from "./api/ApiContext";
import { AuthProvider } from "./auth/AuthContext";
import { RealtimeProvider } from "./api/RealtimeContext";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <ApiProvider>
        <AuthProvider>
          <RealtimeProvider>
            <App />
          </RealtimeProvider>
        </AuthProvider>
      </ApiProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
