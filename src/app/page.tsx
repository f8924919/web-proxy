"use client";

import { useState } from "react";

export default function HomePage() {
  const [url, setUrl] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!url) return;
    const target = url.startsWith("http") ? url : `https://${url}`;
    const base = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
    window.location.href = `${base}/browse?url=${encodeURIComponent(target)}`;
  };

  return (
    <main
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "sans-serif",
        backgroundColor: "#f5f5f5",
      }}
    >
      <h1 style={{ marginBottom: "0.5rem" }}>Web Proxy</h1>
      <p style={{ color: "#666", marginBottom: "2rem" }}>
        アクセスしたい URL を入力してください
      </p>
      <form
        onSubmit={handleSubmit}
        style={{ display: "flex", gap: "0.5rem", width: "100%", maxWidth: 560 }}
      >
        <input
          type="text"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://example.com"
          style={{
            flex: 1,
            padding: "0.6rem 1rem",
            fontSize: "1rem",
            border: "1px solid #ccc",
            borderRadius: 4,
          }}
        />
        <button
          type="submit"
          style={{
            padding: "0.6rem 1.4rem",
            fontSize: "1rem",
            backgroundColor: "#0070f3",
            color: "#fff",
            border: "none",
            borderRadius: 4,
            cursor: "pointer",
          }}
        >
          移動
        </button>
      </form>
    </main>
  );
}
