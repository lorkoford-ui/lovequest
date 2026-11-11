import { getStore } from "@netlify/blobs";

const store = getStore("lovequest-matchmaking");
const response = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
});
const uuidPattern = /^[0-9a-f-]{36}$/i;

async function clearOldQueue() {
  const { blobs } = await store.list({ prefix: "queue:" });
  const now = Date.now();
  for (const item of blobs) {
    const entry = await store.get(item.key, { type: "json" });
    if (!entry || entry.expiresAt <= now) await store.delete(item.key);
  }
}

async function join(userId, role) {
  await clearOldQueue();

  const previous = await store.get(`match:${userId}`, { type: "json" });
  if (previous && previous.expiresAt > Date.now()) {
    return { status: "matched", partnerRole: previous.partnerRole };
  }

  await store.delete(`queue:${userId}`);
  const { blobs } = await store.list({ prefix: "queue:" });

  for (const item of blobs) {
    const candidateId = item.key.slice("queue:".length);
    if (candidateId === userId) continue;

    const candidate = await store.get(item.key, { type: "json" });
    if (!candidate || candidate.expiresAt <= Date.now() || candidate.role === role) continue;

    // Atomic claim: only one searching visitor can claim this waiting visitor.
    const claimKey = `claim:${candidateId}`;
    const claim = await store.setJSON(claimKey, { by: userId, at: Date.now() }, { onlyIfNew: true });
    if (!claim.modified) continue;

    const stillWaiting = await store.get(item.key, { type: "json" });
    if (!stillWaiting || stillWaiting.expiresAt <= Date.now()) {
      await store.delete(claimKey);
      continue;
    }

    const expiry = Date.now() + 60 * 60 * 1000;
    const matchId = crypto.randomUUID();
    await store.setJSON(`match:${userId}`, {
      matchId, partnerId: candidateId, partnerRole: candidate.role, expiresAt: expiry
    });
    await store.setJSON(`match:${candidateId}`, {
      matchId, partnerId: userId, partnerRole: role, expiresAt: expiry
    });
    await store.delete(item.key);
    return { status: "matched", partnerRole: candidate.role };
  }

  await store.setJSON(`queue:${userId}`, {
    role, createdAt: Date.now(), expiresAt: Date.now() + 10 * 60 * 1000
  });
  return { status: "waiting" };
}

export default async (request) => {
  if (request.method !== "POST") return response({ error: "Метод не поддерживается." }, 405);
  try {
    const body = await request.json();
    const { action, userId, role } = body || {};
    if (typeof userId !== "string" || !uuidPattern.test(userId)) {
      return response({ error: "Обнови страницу и попробуй снова." }, 400);
    }

    if (action === "join") {
      if (!["kor", "murch"].includes(role)) return response({ error: "Сначала выбери роль." }, 400);
      return response(await join(userId, role));
    }

    if (action === "check") {
      const match = await store.get(`match:${userId}`, { type: "json" });
      if (match && match.expiresAt > Date.now()) {
        return response({ status: "matched", partnerRole: match.partnerRole });
      }
      const queue = await store.get(`queue:${userId}`, { type: "json" });
      return response(queue && queue.expiresAt > Date.now()
        ? { status: "waiting" }
        : { status: "expired" });
    }

    if (action === "leave") {
      await store.delete(`queue:${userId}`);
      const match = await store.get(`match:${userId}`, { type: "json" });
      if (match?.partnerId) {
        const other = await store.get(`match:${match.partnerId}`, { type: "json" });
        if (other?.matchId === match.matchId) await store.delete(`match:${match.partnerId}`);
      }
      await store.delete(`match:${userId}`);
      return response({ status: "left" });
    }

    return response({ error: "Неизвестное действие." }, 400);
  } catch (error) {
    console.error("LOVEQUEST matchmaking:", error);
    return response({ error: "Ошибка сервера. Попробуй ещё раз позже." }, 500);
  }
};
