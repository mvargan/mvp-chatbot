(function () {
  const apiUrl = window.CHATBOT_API_URL || "http://localhost:3000/chat";

  const root = document.createElement("div");
  root.style.cssText =
    "position:fixed;bottom:16px;right:16px;width:360px;max-width:92vw;font-family:system-ui,Arial;z-index:99999;";

  root.innerHTML = `
    <div id="cb-box" style="border:1px solid #ddd;border-radius:12px;overflow:hidden;box-shadow:0 10px 30px rgba(0,0,0,.12);background:#fff;">
      <div style="padding:10px 12px;background:#111;color:#fff;display:flex;justify-content:space-between;align-items:center;">
        <div style="font-weight:600;">S.O.S. chatbot</div>
        <button id="cb-toggle" style="background:transparent;border:0;color:#fff;font-size:16px;cursor:pointer;">–</button>
      </div>
      <div id="cb-body" style="height:320px;overflow:auto;padding:10px;background:#fafafa;"></div>
      <div id="cb-inputbar" style="display:flex;gap:8px;padding:10px;border-top:1px solid #eee;">
        <input id="cb-input" placeholder="Ask in English..." style="flex:1;padding:10px;border:1px solid #ddd;border-radius:10px;outline:none;" />
        <button id="cb-send" style="padding:10px 12px;border:0;border-radius:10px;cursor:pointer;background:#111;color:#fff;">Send</button>
      </div>
    </div>
  `;

  document.body.appendChild(root);

  const body = root.querySelector("#cb-body");
  const input = root.querySelector("#cb-input");
  const send = root.querySelector("#cb-send");
  const toggle = root.querySelector("#cb-toggle");
  const inputbar = root.querySelector("#cb-inputbar");

  let collapsed = false;

  function addMsg(who, text) {
    const wrap = document.createElement("div");
    wrap.style.cssText =
      `margin:8px 0;display:flex;${who === "user" ? "justify-content:flex-end;" : "justify-content:flex-start;"}`;
    const bubble = document.createElement("div");
    bubble.style.cssText =
      "max-width:85%;padding:10px 12px;border-radius:12px;white-space:pre-wrap;line-height:1.35;" +
      (who === "user"
        ? "background:#111;color:#fff;border-bottom-right-radius:4px;"
        : "background:#fff;color:#111;border:1px solid #eee;border-bottom-left-radius:4px;");
    bubble.textContent = text;
    wrap.appendChild(bubble);
    body.appendChild(wrap);
    body.scrollTop = body.scrollHeight;
    return wrap;
  }

  addMsg("bot", "Hi! I’m the S.O.S. chatbot. Ask me about the Erasmus S.O.S. project.");

  async function sendMsg() {
    const msg = input.value.trim();
    if (!msg) return;
    input.value = "";
    addMsg("user", msg);

    const placeholder = addMsg("bot", "...");

    try {
      const r = await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: msg })
      });
      const data = await r.json();

      placeholder.remove();
      addMsg("bot", data.reply || "No reply.");
      if (data.sources?.length) addMsg("bot", "Sources: " + data.sources.join(", "));
    } catch (e) {
      placeholder.remove();
      addMsg("bot", "Connection error.");
    }
  }

  send.addEventListener("click", sendMsg);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") sendMsg(); });

  toggle.addEventListener("click", () => {
    collapsed = !collapsed;
    body.style.display = collapsed ? "none" : "block";
    inputbar.style.display = collapsed ? "none" : "flex";
    toggle.textContent = collapsed ? "+" : "–";
  });
})();