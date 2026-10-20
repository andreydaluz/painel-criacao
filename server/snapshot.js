import { db, metaSet } from "./db.js";
import { clientFromName } from "./team.js";

export function replaceSnapshot({ members, lists, cards, links, stays }, source) {
  db.exec("BEGIN");
  try {
    db.exec("DELETE FROM card_members");
    db.exec("DELETE FROM cards");
    db.exec("DELETE FROM lists");
    db.exec("DELETE FROM members");
    db.exec("DELETE FROM stays");
    const memberStmt = db.prepare("INSERT INTO members (id, full_name) VALUES (?, ?)");
    for (const member of members) memberStmt.run(member.id, member.fullName);
    const listStmt = db.prepare("INSERT INTO lists (id, name, pos) VALUES (?, ?, ?)");
    for (const list of lists) listStmt.run(list.id, list.name, list.pos ?? 0);
    const cardStmt = db.prepare(
      `INSERT INTO cards (id, name, url, list_id, due, closed, client, created_at, list_entered_at, description)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
    );
    for (const card of cards) {
      cardStmt.run(
        card.id,
        card.name,
        card.url || "",
        card.listId,
        card.due || null,
        card.client || clientFromName(card.name),
        card.createdAt || null,
        card.listEnteredAt || null,
        card.description || null,
      );
    }
    const linkStmt = db.prepare(
      "INSERT OR REPLACE INTO card_members (card_id, member_id, added_at) VALUES (?, ?, ?)",
    );
    for (const link of links) linkStmt.run(link.cardId, link.memberId, link.addedAt || null);
    const stayStmt = db.prepare(
      "INSERT OR REPLACE INTO stays (card_id, list_name, entered_at, left_at) VALUES (?, ?, ?, ?)",
    );
    for (const stay of stays || []) {
      stayStmt.run(stay.cardId, stay.listName, stay.enteredAt, stay.leftAt || null);
    }
    metaSet("source", source);
    metaSet("synced_at", new Date().toISOString());
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
