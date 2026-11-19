// Shared fetch for the Node runners. Retries ride out short outages: waits 5s, 20s, then 60s.
const UA = { "User-Agent": "Mozilla/5.0 (compatible; model-picks/1.0)" };
const WAITS = [5000, 20000, 60000];
const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function get(url, as = "text") {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return as === "json" ? await res.json() : await res.text();
    } catch (e) {
      const where = url.split("?")[0];
      if (attempt >= WAITS.length) throw new Error(`${where}: ${e.message}`);
      console.log(`retry ${where} (${e.message})`);
      await sleep(WAITS[attempt]);
    }
  }
}
