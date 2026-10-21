import { db } from "./db.js";
import { describeDeck } from "./decks.js";
import { clientFromName, loadTeam, norm, roleFor } from "./team.js";

function hoursBetween(from, to) {
  if (!from) return null;
  const ms = to.getTime() - new Date(from).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  return ms / 3600000;
}

function avg(values) {
  const nums = values.filter((value) => value != null);
  if (!nums.length) return null;
  return nums.reduce((sum, value) => sum + value, 0) / nums.length;
}

function round1(value) {
  if (value == null) return null;
  return Math.round(value * 10) / 10;
}

export function formatSpan(hours) {
  if (hours == null) return "sem histórico";
  if (hours < 24) return `${Math.max(1, Math.round(hours))} h`;
  const days = hours / 24;
  if (days < 10) return `${String(round1(days)).replace(".", ",")} dias`;
  return `${Math.round(days)} dias`;
}

function dueLabel(due, now) {
  if (!due) return "Sem prazo";
  const date = new Date(due);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value ?? "";
  const day = `${get("year")}-${get("month")}-${get("day")}`;
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const label = `${get("day")}/${get("month")} ${get("hour")}:${get("minute")}`;
  if (day < today) return `Atrasado · ${label}`;
  if (day === today) return `Hoje · ${label}`;
  return label;
}

export async function buildDashboard(now = new Date()) {
  const team = loadTeam();
  const lists = db.prepare("SELECT id, name FROM lists").all();
  const listName = new Map(lists.map((list) => [list.id, list.name]));
  const members = db.prepare("SELECT id, full_name FROM members").all();
  const memberName = new Map(members.map((member) => [member.id, member.full_name]));
  const cards = db
    .prepare(
      `SELECT id, name, url, list_id, due, closed, client, created_at, list_entered_at, description
       FROM cards WHERE closed = 0`,
    )
    .all();
  const links = db.prepare("SELECT card_id, member_id, added_at FROM card_members").all();
  const stays = db
    .prepare("SELECT card_id, list_name, entered_at, left_at FROM stays")
    .all();
  const staysByCard = new Map();
  for (const stay of stays) {
    const list = staysByCard.get(stay.card_id) || [];
    list.push(stay);
    staysByCard.set(stay.card_id, list);
  }

  function staySplit(cardId) {
    let hoursInExecution = null;
    let hoursInAdjustments = null;
    let hoursElsewhere = null;
    const otherNames = [];
    for (const stay of staysByCard.get(cardId) || []) {
      const end = stay.left_at ? new Date(stay.left_at) : now;
      const hours = hoursBetween(stay.entered_at, end);
      if (hours == null) continue;
      const list = norm(stay.list_name);
      if (list === norm("EM EXECUÇÃO")) hoursInExecution = (hoursInExecution ?? 0) + hours;
      else if (list === norm("ALTERAÇÕES")) hoursInAdjustments = (hoursInAdjustments ?? 0) + hours;
      else {
        hoursElsewhere = (hoursElsewhere ?? 0) + hours;
        if (!otherNames.includes(stay.list_name)) otherNames.push(stay.list_name);
      }
    }
    return {
      hoursInExecution,
      hoursInAdjustments,
      hoursElsewhere,
      elsewhereLabel: otherNames.length > 1 ? "Outras colunas" : otherNames[0] ? titleList(otherNames[0]) : null,
    };
  }

  const membersByCard = new Map();
  for (const link of links) {
    const list = membersByCard.get(link.card_id) || [];
    list.push(link);
    membersByCard.set(link.card_id, list);
  }

  const flow = new Set(team.flowLists.map(norm));
  const house = new Set(team.houseLists.map(norm));
  const done = new Set(team.doneLists.map(norm));
  const ignore = new Set(team.ignoreLists.map(norm));

  const shaped = cards
    .map((card) => {
      const list = listName.get(card.list_id) || "Sem lista";
      const people = (membersByCard.get(card.id) || []).map((link) => {
        const fullName = memberName.get(link.member_id) || "Sem nome";
        const role = roleFor(team, fullName);
        return {
          id: link.member_id,
          name: displayNameFor(team, fullName),
          ...role,
          addedAt: link.added_at,
          hoursOnCard: hoursBetween(link.added_at, now),
        };
      });
      return {
        ...card,
        client: clientFromName(card.name),
        list,
        people,
        hoursInList: hoursBetween(card.list_entered_at, now),
        ...staySplit(card.id),
        dueLabel: dueLabel(card.due, now),
        overdue: Boolean(card.due && new Date(card.due) < now),
      };
    })
    .filter((card) => !ignore.has(norm(card.list)) && !done.has(norm(card.list)));

  await Promise.all(shaped.map(async (card) => {
    card.deck = await describeDeck(card);
  }));

  const inFlow = shaped.filter((card) => flow.has(norm(card.list)));
  const inHouse = shaped.filter((card) => house.has(norm(card.list)));

  const daDirectory = team.das.map((person) => {
    const mine = inFlow.filter((card) =>
      card.people.some((member) => norm(member.name) === norm(person.name)),
    );
    const houseCards = mine.filter((card) => house.has(norm(card.list)));
    const clients = [...new Set(houseCards.map((card) => card.client))];
    const markedClients = [...new Set(mine.map((card) => card.client))];
    const hours = houseCards.map((card) => {
      const member = card.people.find((item) => norm(item.name) === norm(person.name));
      return member?.hoursOnCard ?? null;
    });
    return {
      name: person.displayName || person.name,
      active: person.active !== false,
      note: person.note || "",
      openCards: houseCards.length,
      withClient: mine.length - houseCards.length,
      clients,
      clientCount: clients.length,
      markedClients,
      markedClientCount: markedClients.length,
      avgHoursOnCard: avg(hours),
      overLimit: person.active !== false && houseCards.length > team.wipLimit,
      cards: mine
        .map((card) => {
          const member = card.people.find((item) => norm(item.name) === norm(person.name));
          return {
            id: card.id,
            name: card.name,
            url: card.url,
            client: card.client,
            list: card.list,
            due: card.due || null,
            dueLabel: card.dueLabel,
            overdue: card.overdue,
            assignedAt: member?.addedAt || card.created_at || null,
            parked: !house.has(norm(card.list)),
            hoursOnCard: member?.hoursOnCard ?? null,
            hoursInList: card.hoursInList,
            hoursInExecution: card.hoursInExecution,
            hoursInAdjustments: card.hoursInAdjustments,
            hoursElsewhere: card.hoursElsewhere,
            elsewhereLabel: card.elsewhereLabel,
            deck: card.deck,
          };
        })
        .sort((a, b) => Number(a.parked) - Number(b.parked) || (b.hoursOnCard ?? 0) - (a.hoursOnCard ?? 0)),
    };
  });

  const columnOrder = [...team.flowLists];
  const columns = columnOrder.map((name) => {
    const rows = inFlow.filter((card) => norm(card.list) === norm(name));
    const completed = stays.filter(
      (stay) => norm(stay.list_name) === norm(name) && stay.left_at,
    );
    return {
      name,
      openCount: rows.length,
      avgHoursOpen: avg(rows.map((card) => card.hoursInList)),
      avgHoursCompleted: avg(
        completed.map((stay) => hoursBetween(stay.entered_at, new Date(stay.left_at))),
      ),
      sampleCompleted: completed.length,
    };
  });

  const atendimento = team.atendimento.map((name) => {
    const mine = inFlow.filter((card) =>
      card.people.some((member) => norm(member.name) === norm(name)),
    );
    const byColumn = columnOrder.map((list) => {
      const rows = mine.filter((card) => norm(card.list) === norm(list));
      return {
        name: list,
        count: rows.length,
        avgHours: avg(rows.map((card) => card.hoursInList)),
      };
    });
    return {
      name,
      openCards: mine.length,
      clients: [...new Set(mine.map((card) => card.client))],
      byColumn: byColumn.filter((column) => column.count > 0),
    };
  }).sort((a, b) => b.openCards - a.openCards);

  const clientMap = new Map();
  for (const card of inFlow) {
    const row = clientMap.get(card.client) || {
      name: card.client,
      openCards: 0,
      inHouse: 0,
      das: new Set(),
      atendimento: new Set(),
      hoursInHouse: [],
    };
    row.openCards += 1;
    if (house.has(norm(card.list))) {
      row.inHouse += 1;
      if (card.hoursInList != null) row.hoursInHouse.push(card.hoursInList);
    }
    for (const person of card.people) {
      if (person.role === "da") row.das.add(person.name);
      if (person.role === "atendimento") row.atendimento.add(person.name);
    }
    clientMap.set(card.client, row);
  }
  const clients = [...clientMap.values()]
    .map((row) => ({
      name: row.name,
      openCards: row.openCards,
      inHouse: row.inHouse,
      das: [...row.das],
      atendimento: [...row.atendimento],
      avgHoursInHouse: avg(row.hoursInHouse),
      houseTimed: row.hoursInHouse.length,
    }))
    .sort((a, b) => b.openCards - a.openCards);

  const noDa = inHouse.filter(
    (card) => !card.people.some((person) => person.role === "da" && person.active),
  );
  const inactiveOnCards = inFlow.flatMap((card) =>
    card.people
      .filter((person) => person.role === "da" && !person.active)
      .map((person) => ({ person: person.name, card: card.name, list: card.list })),
  );
  const stuck = inHouse.filter(
    (card) => card.hoursInList != null && card.hoursInList / 24 >= team.stuckDays,
  );
  const overLimit = daDirectory.filter((person) => person.overLimit).length;

  const argumentsForPartners = buildArguments({
    team,
    daDirectory,
    columns,
    noDa,
    inactiveOnCards,
    stuck,
    inHouse,
    inFlow,
  });

  return {
    generatedAt: now.toISOString(),
    timezone: "America/Sao_Paulo",
    source: db.prepare("SELECT value FROM meta WHERE key = 'source'").get()?.value || "vazio",
    syncedAt: db.prepare("SELECT value FROM meta WHERE key = 'synced_at'").get()?.value || null,
    boardName: team.boardName,
    brand: team.brand || "",
    tagline: team.tagline || "",
    wipLimit: team.wipLimit,
    stuckDays: team.stuckDays,
    roster: {
      socios: team.socios || [],
      trafego: team.trafego || [],
    },
    kpis: [
      { label: "Cartões na casa", value: String(inHouse.length), detail: "Fora de aprovados, finalizados e projetos especiais" },
      { label: "Parados no cliente", value: String(inFlow.length - inHouse.length), detail: "Ainda marcados, já em aprovação do cliente" },
      {
        label: overLimit === 1 ? "DA acima do limite" : "DAs acima do limite",
        value: String(overLimit),
        detail: `Limite deste painel: ${team.wipLimit} cartões na casa`,
      },
      {
        label: "Sem DA ativo",
        value: String(noDa.length),
        detail: "Na casa, sem um designer ativo marcado",
      },
      {
        label: "Há mais de " + team.stuckDays + " dias na coluna",
        value: String(stuck.length),
        detail: "Tempo já decorrido na coluna atual",
      },
    ],
    das: daDirectory,
    columns,
    atendimento,
    clients,
    workLists: team.workLists || ["EM EXECUÇÃO"],
    pauseLists: team.pauseLists || [],
    clientTime: buildClientTime(
      now,
      new Map(cards.map((card) => [card.id, clientFromName(card.name)])),
      team.workLists || ["EM EXECUÇÃO"],
    ),
    noDa: noDa.map((card) => ({
      name: card.name,
      url: card.url,
      list: card.list,
      client: card.client,
      dueLabel: card.dueLabel,
    })),
    arguments: argumentsForPartners,
    reading:
      "O tempo mostrado aqui é de fila (marcação no cartão e entrada na coluna). Nas horas por cliente, só conta o que ficou em Em execução — Alterações e Em pausa ficam de fora.",
  };
}

const SP_OFFSET_MS = 3 * 3600000;
const MONTHS = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
const MONTH_NAMES = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];

function monthIndex(ms) {
  const local = new Date(ms - SP_OFFSET_MS);
  return local.getUTCFullYear() * 12 + local.getUTCMonth();
}

function monthStart(index) {
  return Date.UTC(Math.floor(index / 12), index % 12, 1) + SP_OFFSET_MS;
}

const WORK_BLOCKS = [[9, 12], [13, 18]];

function businessHours(from, to) {
  const local = new Date(from - SP_OFFSET_MS);
  let day = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) + SP_OFFSET_MS;
  let total = 0;
  while (day < to) {
    const weekday = new Date(day - SP_OFFSET_MS).getUTCDay();
    if (weekday >= 1 && weekday <= 5) {
      for (const [startHour, endHour] of WORK_BLOCKS) {
        const start = Math.max(from, day + startHour * 3600000);
        const end = Math.min(to, day + endHour * 3600000);
        if (end > start) total += end - start;
      }
    }
    day += 86400000;
  }
  return total / 3600000;
}

function buildClientTime(now, clientByCard, workLists = ["EM EXECUÇÃO"]) {
  const rows = db.prepare("SELECT card_id, date, payload FROM actions WHERE card_id IS NOT NULL ORDER BY date ASC").all();
  if (!rows.length) return null;
  const working = new Set((workLists.length ? workLists : ["EM EXECUÇÃO"]).map(norm));
  const byCard = new Map();
  for (const row of rows) {
    const list = byCard.get(row.card_id) || [];
    list.push(JSON.parse(row.payload));
    byCard.set(row.card_id, list);
  }

  const nowMs = now.getTime();
  const current = monthIndex(nowMs);
  const first = monthIndex(new Date(rows[0].date).getTime()) + 1;
  const averaged = [];
  for (let index = first; index < current; index += 1) averaged.push(index);
  const totals = new Map();

  function add(client, cardId, from, to) {
    for (let index = monthIndex(from); index <= monthIndex(to - 1); index += 1) {
      const start = Math.max(from, monthStart(index));
      const end = Math.min(to, monthStart(index + 1));
      if (end <= start) continue;
      const months = totals.get(client) || new Map();
      const month = months.get(index) || { hours: 0, businessHours: 0, cards: new Map() };
      const hours = (end - start) / 3600000;
      month.hours += hours;
      month.businessHours += businessHours(start, end);
      month.cards.set(cardId, (month.cards.get(cardId) || 0) + hours);
      months.set(index, month);
      totals.set(client, months);
    }
  }

  function period(month) {
    return month
      ? { tasks: [...month.cards.values()].filter((hours) => hours >= 0.5).length, hours: month.hours, businessHours: month.businessHours }
      : { tasks: 0, hours: 0, businessHours: 0 };
  }

  function averagePeriod(months) {
    if (!averaged.length) return null;
    const rows = averaged.map((index) => period(months.get(index)));
    const mean = (key) => rows.reduce((sum, row) => sum + row[key], 0) / rows.length;
    return { tasks: mean("tasks"), hours: mean("hours"), businessHours: mean("businessHours") };
  }

  for (const [cardId, actions] of byCard) {
    const name = actions.findLast((action) => action.data?.card?.name)?.data.card.name || "";
    const client = clientByCard.get(cardId) || clientFromName(name);
    let list = null;
    let since = null;
    const close = (at) => {
      if (list && since != null && working.has(norm(list))) add(client, cardId, since, at);
    };
    for (const action of actions) {
      const at = new Date(action.date).getTime();
      if (action.type === "createCard" && action.data?.list?.name) {
        list = action.data.list.name;
        since = at;
      } else if (action.type === "updateCard" && action.data?.listAfter?.name) {
        close(at);
        list = action.data.listAfter.name;
        since = at;
      } else if (action.type === "updateCard" && action.data?.card?.closed === true && action.data?.old?.closed === false) {
        close(at);
        list = null;
        since = null;
      }
    }
    close(nowMs);
  }

  const label = (index) => `${MONTHS[index % 12]}/${String(Math.floor(index / 12)).slice(2)}`;
  return {
    currentLabel: MONTH_NAMES[current % 12],
    previousLabel: MONTH_NAMES[(current - 1) % 12],
    averageLabel: averaged.length ? `${label(averaged[0])} a ${label(averaged.at(-1))}` : null,
    averageMonths: averaged.length,
    historySince: rows[0].date,
    clients: [...totals.entries()]
      .map(([name, months]) => ({
        name,
        current: period(months.get(current)),
        previous: period(months.get(current - 1)),
        average: averagePeriod(months),
      }))
      .filter((row) => row.current.tasks || row.previous.tasks || row.average?.tasks)
      .sort((a, b) => b.current.businessHours - a.current.businessHours || b.previous.businessHours - a.previous.businessHours),
  };
}

function buildArguments({ team, daDirectory, columns, noDa, inactiveOnCards, stuck, inHouse, inFlow }) {
  const notes = [];
  const activeDas = daDirectory.filter((person) => person.active);
  const busiest = [...activeDas].sort((a, b) => b.openCards - a.openCards)[0];
  const lightest = [...activeDas].filter((person) => person.openCards > 0).sort((a, b) => a.openCards - b.openCards)[0];
  if (busiest && busiest.openCards >= team.wipLimit) {
    notes.push({
      title: `${first(busiest.name)} concentra a fila`,
      text: `${busiest.name} está em ${busiest.openCards} cartões na casa, em ${busiest.clientCount} cliente${busiest.clientCount === 1 ? "" : "s"}. O limite deste painel é ${team.wipLimit} cartões por DA. ${lightest && lightest.name !== busiest.name ? `${first(lightest.name)} está em ${lightest.openCards}.` : ""} A fila não está dividida por igual.`,
    });
  }

  const clientCol = columns.find((column) => norm(column.name) === norm("APROVAÇÃO CLIENTE"));
  const doingCol = columns.find((column) => norm(column.name) === norm("EM EXECUÇÃO"));
  const doingCount = doingCol?.openCount || 0;
  if (clientCol && doingCount && clientCol.openCount > doingCount) {
    notes.push({
      title: "Tem mais peça esperando o cliente do que sendo feita",
      text: `${clientCol.openCount} cartões estão em aprovação do cliente e ${doingCount} em execução. Só Em execução conta como tempo de trabalho do DA. O que está com o cliente já saiu da mesa${clientCol.avgHoursOpen != null ? `. O tempo médio parado com o cliente, onde há data de entrada, é ${formatSpan(clientCol.avgHoursOpen)}` : ""}.`,
    });
  }

  if (stuck.length) {
    const oldest = [...stuck].sort((a, b) => (b.hoursInList ?? 0) - (a.hoursInList ?? 0))[0];
    const list = norm(oldest.list);
    const head = `O mais antigo na casa é “${oldest.name}”, há ${formatSpan(oldest.hoursInList)} em ${titleList(oldest.list)}.`;
    let detail;
    if (list === norm("EM EXECUÇÃO")) {
      detail = "Esse tempo em Em execução entra nas horas do cliente.";
    } else if (list === norm("ALTERAÇÕES") || list === norm("EM PAUSA")) {
      detail = "É tempo de fila: não entra nas horas trabalhadas do cliente. Vale olhar se alguém precisa retomar a peça.";
    } else {
      detail = "Vale olhar se a peça precisa avançar de coluna.";
    }
    notes.push({
      title: `${piece(stuck.length)} já ${stuck.length === 1 ? "passou" : "passaram"} de ${team.stuckDays} dias na mesma coluna`,
      text: `${head} ${detail}`,
    });
  }

  if (inactiveOnCards.length) {
    const names = [...new Set(inactiveOnCards.map((row) => row.person))];
    notes.push({
      title: "Pessoa desligada ainda está na fila",
      text: `${names.join(", ")} ainda está marcado em ${piece(inactiveOnCards.length)} abertos, incluindo o que já está com o cliente. Sem um DA ativo no cartão, a task segue sem dono na criação.`,
    });
  }

  if (noDa.length) {
    notes.push({
      title: `${piece(noDa.length)} na casa sem DA ativo`,
      text: noDa
        .slice(0, 4)
        .map((card) => `${card.name} (${titleList(card.list)})`)
        .join("; ") + (noDa.length > 4 ? "…" : "") + ". Estes cartões estão na casa e não entram na carga de nenhum DA.",
    });
  }

  const multiClient = activeDas.filter((person) => person.clientCount >= 4);
  if (multiClient.length) {
    notes.push({
      title: "Troca de contexto está alta",
      text: multiClient
        .map((person) => `${first(person.name)} em ${person.clientCount} clientes (${person.clients.join(", ")})`)
        .join(". ") + ". A mesma pessoa está em vários clientes ao mesmo tempo.",
    });
  }

  const shared = inHouse.filter((card) => card.people.filter((person) => person.role === "da" && person.active).length >= 2);
  if (shared.length) {
    notes.push({
      title: "Cartão compartilhado conta para mais de um DA",
      text: `${piece(shared.length)} na casa ${shared.length === 1 ? "tem" : "têm"} dois ou mais DAs. A soma das cargas é maior do que a quantidade de peças: um cartão, várias pessoas, uma fila só.`,
    });
  }

  if (!notes.length) {
    notes.push({
      title: "A fila está dentro do limite configurado",
      text: `${inHouse.length} cartões na casa e ${inFlow.length - inHouse.length} com o cliente. A fila está dentro do limite deste painel.`,
    });
  }
  return notes;
}

function piece(count) {
  return count === 1 ? "1 cartão" : `${count} cartões`;
}

function first(name) {
  return name.split(" ")[0];
}

function displayNameFor(team, fullName) {
  const key = norm(fullName);
  return team.das.find((person) => norm(person.name) === key)?.displayName || fullName;
}

function titleList(name) {
  return name.charAt(0) + name.slice(1).toLowerCase();
}
