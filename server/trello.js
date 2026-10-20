import { db, metaGet, metaSet } from "./db.js";
import { replaceSnapshot } from "./snapshot.js";

function boardId() {
  return process.env.TRELLO_BOARD_ID;
}

function configured() {
  return Boolean(process.env.TRELLO_KEY && process.env.TRELLO_TOKEN && boardId());
}

async function trello(path, params = {}) {
  const url = new URL(`https://api.trello.com/1${path}`);
  url.searchParams.set("key", process.env.TRELLO_KEY);
  url.searchParams.set("token", process.env.TRELLO_TOKEN);
  for (const [key, value] of Object.entries(params)) {
    if (value != null) url.searchParams.set(key, String(value));
  }
  const response = await fetch(url);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Trello respondeu ${response.status}: ${body.slice(0, 240)}`);
  }
  return response.json();
}

export async function syncTrello() {
  if (!configured()) {
    return {
      ok: false,
      reason: "Faltam TRELLO_KEY, TRELLO_TOKEN ou TRELLO_BOARD_ID. O painel continua na última leitura salva.",
    };
  }

  const board = await trello(`/boards/${boardId()}`, {
    fields: "name,url",
    lists: "open",
    list_fields: "name,pos",
    cards: "open",
    card_fields: "name,url,idList,idMembers,due,dateLastActivity,closed,desc",
    card_members: "true",
    members: "all",
    member_fields: "fullName",
  });

  const lists = (board.lists || []).map((list) => ({
    id: list.id,
    name: list.name,
    pos: list.pos,
  }));
  const listName = new Map(lists.map((list) => [list.id, list.name]));
  const members = (board.members || []).map((member) => ({
    id: member.id,
    fullName: member.fullName,
  }));

  const fresh = await fetchActions();
  saveActions(fresh);
  const actions = db
    .prepare("SELECT id, type, date, card_id, payload FROM actions ORDER BY date ASC")
    .all()
    .map((row) => ({ ...JSON.parse(row.payload), id: row.id, type: row.type, date: row.date }));
  const byCard = new Map();
  for (const action of actions) {
    const cardId = action.data?.card?.id;
    if (!cardId) continue;
    const list = byCard.get(cardId) || [];
    list.push(action);
    byCard.set(cardId, list);
  }

  const cards = [];
  const links = [];
  const stays = [];

  for (const card of board.cards || []) {
    if (card.closed) continue;
    const history = (byCard.get(card.id) || []).sort((a, b) => a.date.localeCompare(b.date));
    const built = buildStays(history, listName);
    const currentList = listName.get(card.idList) || "";
    const openStay = [...built.stays].reverse().find((stay) => !stay.leftAt && stay.listName === currentList);
    cards.push({
      id: card.id,
      name: card.name,
      url: card.url || `https://trello.com/c/${card.id}`,
      listId: card.idList,
      due: card.due || null,
      createdAt: built.createdAt,
      listEnteredAt: openStay?.enteredAt || null,
      description: card.desc || "",
    });
    stays.push(...built.stays.map((stay) => ({ ...stay, cardId: card.id })));

    const added = latestAssignments(history);
    for (const memberId of card.idMembers || []) {
      links.push({
        cardId: card.id,
        memberId,
        addedAt: added.get(memberId) || null,
      });
    }
  }

  replaceSnapshot({ members, lists, cards, links, stays }, "trello");
  if (fresh.length) {
    const newest = fresh.map((action) => action.date).sort().at(-1);
    metaSet("actions_since", newest);
  }
  metaSet("board_url", board.url || "");
  return { ok: true, cards: cards.length, actions: actions.length };
}

async function fetchActions() {
  const since = metaGet("actions_since");
  const collected = [];
  let before = null;
  for (let page = 0; page < 25; page += 1) {
    const batch = await trello(`/boards/${boardId()}/actions`, {
      filter: "updateCard,addMemberToCard,removeMemberFromCard,createCard",
      limit: 1000,
      since: since || undefined,
      before: before || undefined,
    });
    if (!batch.length) break;
    collected.push(...batch);
    before = batch[batch.length - 1].id;
    const oldest = batch[batch.length - 1].date;
    if (batch.length < 1000) break;
    if (!since && oldest < new Date(Date.now() - 120 * 86400000).toISOString()) break;
  }
  return collected;
}

function saveActions(actions) {
  const stmt = db.prepare(
    "INSERT INTO actions (id, type, date, card_id, payload) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING",
  );
  db.exec("BEGIN");
  try {
    for (const action of actions) {
      stmt.run(
        action.id,
        action.type,
        action.date,
        action.data?.card?.id || null,
        JSON.stringify({
          type: action.type,
          date: action.date,
          data: action.data || {},
          member: action.member ? { id: action.member.id, fullName: action.member.fullName } : null,
        }),
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function buildStays(history, listName) {
  const stays = [];
  let current = null;
  let entered = null;
  let createdAt = null;
  for (const action of history) {
    if (action.type === "createCard") {
      createdAt = action.date;
      const listId = action.data?.list?.id;
      current = listName.get(listId) || action.data?.list?.name || current;
      entered = action.date;
      continue;
    }
    if (action.type === "updateCard" && action.data?.listAfter) {
      const next = action.data.listAfter.name;
      if (current && entered) {
        stays.push({ listName: current, enteredAt: entered, leftAt: action.date });
      }
      current = next;
      entered = action.date;
    }
  }
  if (current && entered) {
    stays.push({ listName: current, enteredAt: entered, leftAt: null });
  }
  return { stays, createdAt };
}

function latestAssignments(history) {
  const added = new Map();
  for (const action of history) {
    const memberId = action.data?.idMember || action.member?.id;
    if (!memberId) continue;
    if (action.type === "addMemberToCard") added.set(memberId, action.date);
    if (action.type === "removeMemberFromCard") added.delete(memberId);
  }
  return added;
}
