import test from "node:test";
import assert from "node:assert/strict";
import { aliceResponse, fitAliceText, isSearchIntent, isWeatherIntent, safeHistory } from "../api/index.js";

test("Alice response uses required response envelope", () => {
  const result = aliceResponse("Привет", false, [{ role: "user", text: "тест" }]);
  assert.equal(result.version, "1.0");
  assert.equal(result.response.text, "Привет");
  assert.equal(result.response.end_session, false);
  assert.deepEqual(result.session_state.history, [{ role: "user", text: "тест" }]);
});

test("search intent detects Russian and English freshness requests", () => {
  assert.equal(isSearchIntent("Какая погода сегодня?"), true);
  assert.equal(isSearchIntent("What is the latest news?"), true);
  assert.equal(isSearchIntent("Расскажи сказку"), false);
});

test("weather intent detects a question about current weather", () => {
  assert.equal(isWeatherIntent("Какая сейчас погода в Смоленске?"), true);
  assert.equal(isWeatherIntent("Сколько будет два плюс два?"), false);
});

test("long responses are cut at a natural boundary and stay within Alice limit", () => {
  const value = fitAliceText(("Это короткое предложение. ").repeat(100));
  assert.ok(value.length <= 1024);
  assert.ok(value.endsWith("."));
});

test("history filters malformed messages and keeps last 8", () => {
  const input = Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? "model" : "user", text: String(i) }));
  input.push({ role: "hacker", text: "ignore" }, { role: "user", text: 17 });
  const result = safeHistory(input);
  assert.equal(result.length, 8);
  assert.equal(result[0].text, "4");
  assert.equal(result[7].text, "11");
});

test("GET health check returns an ok response", async () => {
  const handler = (await import("../api/index.js")).default;
  let statusCode = 200;
  let payload;
  const res = {
    status(code) { statusCode = code; return this; },
    json(value) { payload = value; return value; },
    setHeader() {}
  };
  await handler({ method: "GET" }, res);
  assert.equal(statusCode, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.service, "alice-gemini-serper");
});

test("launch request returns a valid Alice greeting without external API keys", async () => {
  const handler = (await import("../api/index.js")).default;
  let statusCode = 200;
  let payload;
  const res = {
    status(code) { statusCode = code; return this; },
    json(value) { payload = value; return value; },
    setHeader() {}
  };
  await handler({ method: "POST", body: { request: { command: "" }, state: { session: { history: [] } } } }, res);
  assert.equal(statusCode, 200);
  assert.equal(payload.version, "1.0");
  assert.match(payload.response.text, /Привет/);
  assert.equal(payload.response.end_session, false);
});

test("weather question uses current forecast and answers without Gemini", async () => {
  const handler = (await import("../api/index.js")).default;
  const originalFetch = globalThis.fetch;
  const requestedUrls = [];
  globalThis.fetch = async url => {
    requestedUrls.push(String(url));
    if (requestedUrls.length === 1) {
      return { ok: true, json: async () => ({ results: [{ name: "Смоленск", latitude: 54.78, longitude: 32.05 }] }) };
    }
    return { ok: true, json: async () => ({ current: { temperature_2m: 4.4, weather_code: 3 } }) };
  };
  let payload;
  const res = {
    status() { return this; },
    json(value) { payload = value; return value; }
  };
  try {
    await handler({
      method: "POST",
      body: {
        request: {
          command: "какая сейчас погода в смоленске",
          nlu: { entities: [{ type: "YANDEX.GEO", value: { city: "смоленск" } }] }
        },
        state: { session: { history: [] } }
      }
    }, res);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(requestedUrls.length, 2);
  assert.match(requestedUrls[0], /geocoding-api\.open-meteo\.com/);
  assert.match(requestedUrls[1], /api\.open-meteo\.com/);
  assert.match(payload.response.text, /Смоленск.*облачно.*4 градусов/);
  assert.equal(payload.response.end_session, false);
});

test("fresh news request does not ask Gemini to invent news without search", async () => {
  const handler = (await import("../api/index.js")).default;
  const originalKey = process.env.SERPER_API_KEY;
  const originalFetch = globalThis.fetch;
  delete process.env.SERPER_API_KEY;
  globalThis.fetch = () => { throw new Error("Unexpected external request"); };
  let payload;
  try {
    await handler({ method: "POST", body: { request: { command: "какие новости в смоленске сегодня" } } }, {
      status() { return this; },
      json(value) { payload = value; return value; }
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.SERPER_API_KEY;
    else process.env.SERPER_API_KEY = originalKey;
  }
  assert.match(payload.response.text, /Не удалось получить свежие результаты поиска/);
});

test("fresh news request passes Serper results to Gemini", async () => {
  const handler = (await import("../api/index.js")).default;
  const originalFetch = globalThis.fetch;
  const originalSearchKey = process.env.SERPER_API_KEY;
  const originalGeminiKey = process.env.GEMINI_API_KEY;
  process.env.SERPER_API_KEY = "test-serper-key";
  process.env.GEMINI_API_KEY = "test-gemini-key";
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    if (requests.length === 1) return {
      ok: true,
      json: async () => ({ news: [{ title: "Новость Смоленска", snippet: "Открыли новый парк", date: "20 октября", source: "Тестовое СМИ", link: "https://example.org/news" }] })
    };
    return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: "В Смоленске открыли новый парк." }] } }] }) };
  };
  let payload;
  try {
    await handler({ method: "POST", body: { request: { command: "какие новости в смоленске сегодня" } } }, {
      status() { return this; },
      json(value) { payload = value; return value; }
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalSearchKey === undefined) delete process.env.SERPER_API_KEY;
    else process.env.SERPER_API_KEY = originalSearchKey;
    if (originalGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalGeminiKey;
  }
  assert.match(requests[0].url, /google\.serper\.dev\/news/);
  assert.equal(JSON.parse(requests[0].options.body).tbs, "qdr:d");
  assert.match(requests[1].url, /generativelanguage\.googleapis\.com/);
  assert.match(JSON.parse(requests[1].options.body).contents.at(-1).parts[0].text, /Открыли новый парк/);
  assert.equal(payload.response.text, "В Смоленске открыли новый парк.");
});

test("fresh news request speaks a search result if Gemini fails", async () => {
  const handler = (await import("../api/index.js")).default;
  const originalFetch = globalThis.fetch;
  const originalSearchKey = process.env.SERPER_API_KEY;
  const originalGeminiKey = process.env.GEMINI_API_KEY;
  process.env.SERPER_API_KEY = "test-serper-key";
  process.env.GEMINI_API_KEY = "test-gemini-key";
  let requestCount = 0;
  globalThis.fetch = async () => {
    requestCount += 1;
    if (requestCount === 1) return {
      ok: true,
      json: async () => ({ news: [{ title: "Новость Смоленска", snippet: "Открыли новый парк", date: "20 октября" }] })
    };
    throw new Error("Gemini unavailable");
  };
  let payload;
  try {
    await handler({ method: "POST", body: { request: { command: "какие новости в смоленске сегодня" } } }, {
      status() { return this; },
      json(value) { payload = value; return value; }
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalSearchKey === undefined) delete process.env.SERPER_API_KEY;
    else process.env.SERPER_API_KEY = originalSearchKey;
    if (originalGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalGeminiKey;
  }
  assert.equal(requestCount, 2);
  assert.match(payload.response.text, /По результатам поиска: Новость Смоленска.*Открыли новый парк/);
});

test("other fresh requests use web search results", async () => {
  const handler = (await import("../api/index.js")).default;
  const originalFetch = globalThis.fetch;
  const originalSearchKey = process.env.SERPER_API_KEY;
  const originalGeminiKey = process.env.GEMINI_API_KEY;
  process.env.SERPER_API_KEY = "test-serper-key";
  process.env.GEMINI_API_KEY = "test-gemini-key";
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    if (requests.length === 1) return {
      ok: true,
      json: async () => ({ organic: [{ title: "Курсы валют", snippet: "Курс найден", link: "https://example.org/rates" }] })
    };
    return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: "Курс найден в интернете." }] } }] }) };
  };
  let payload;
  try {
    await handler({ method: "POST", body: { request: { command: "какой курс валют сегодня" } } }, {
      status() { return this; },
      json(value) { payload = value; return value; }
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalSearchKey === undefined) delete process.env.SERPER_API_KEY;
    else process.env.SERPER_API_KEY = originalSearchKey;
    if (originalGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalGeminiKey;
  }
  assert.match(requests[0].url, /google\.serper\.dev\/search/);
  assert.match(JSON.parse(requests[1].options.body).contents.at(-1).parts[0].text, /Курс найден/);
  assert.equal(payload.response.text, "Курс найден в интернете.");
});
