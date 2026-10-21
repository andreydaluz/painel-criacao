import { useEffect, useMemo, useState } from "react";
import { forget, unlockWithPassword, unlockWithSaved } from "./vault.js";

const STATIC = import.meta.env.VITE_STATIC === "1";

const VIEWS = [
  ["entrega", "Entrega"],
  ["pessoas", "Pessoas"],
  ["colunas", "Colunas"],
  ["clientes", "Clientes"],
  ["mesa", "Mesa"],
];

function span(hours) {
  if (hours == null) return "sem histórico";
  if (Math.round(hours) < 24) return `${Math.max(1, Math.round(hours))} h`;
  const days = hours / 24;
  const value = days < 10 ? String(Math.round(days * 10) / 10).replace(".", ",") : String(Math.round(days));
  return `${value} ${value === "1" ? "dia" : "dias"}`;
}

function decimal(value) {
  return String(Math.round(value * 10) / 10).replace(".", ",");
}

function PeriodCell({ value, average = false }) {
  if (!value || value.tasks < 0.05) return <td className="right">—</td>;
  const tasks = average ? decimal(value.tasks) : String(value.tasks);
  const businessDays = decimal(value.businessHours / 8);
  const perTask = value.businessHours / value.tasks;
  const perTaskDays = decimal(perTask / 8);
  return (
    <td className="right">
      <b className="period-main">{tasks} {tasks === "1" ? "task" : "tasks"}{average ? " por mês" : ""}</b>
      <span className="period-line">{Math.round(value.businessHours).toLocaleString("pt-BR")} h úteis · {businessDays} {businessDays === "1" ? "dia útil" : "dias úteis"}</span>
      <span className="period-task">Média por task: {Math.round(perTask).toLocaleString("pt-BR")} h úteis · {perTaskDays} {perTaskDays === "1" ? "dia útil" : "dias úteis"}</span>
      <span className="period-sub">{Math.round(value.hours).toLocaleString("pt-BR")} h corridas</span>
    </td>
  );
}

function capital(text) {
  return text.charAt(0).toLocaleUpperCase("pt-BR") + text.slice(1);
}

function first(name) {
  return name.split(" ")[0];
}

function displayName(name) {
  return name;
}

function Gate({ onUnlock }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      onUnlock(await unlockWithPassword(password));
    } catch (reason) {
      setMessage(reason.name === "OperationError" ? "Senha incorreta." : reason.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="stripe" />
      <main className="gate">
        <form className="gate-card" onSubmit={submit}>
          <h1>Painel de criação</h1>
          <label htmlFor="senha">Senha</label>
          <input id="senha" type="password" autoComplete="current-password" autoFocus required value={password} onChange={(event) => setPassword(event.target.value)} />
          <button type="submit" disabled={busy}>{busy ? "Abrindo…" : "Entrar"}</button>
          {message && <div className="gate-error">{message}</div>}
        </form>
      </main>
    </>
  );
}

function shorts(names) {
  const labels = names.map(first);
  return labels.map((label, index) => {
    if (labels.filter((item) => item === label).length < 2) return label;
    const rest = names[index].split(" ").slice(1).find(Boolean) || "";
    return rest ? `${label} ${rest[0]}.` : label;
  });
}

function listLabel(name) {
  const lower = name.toLocaleLowerCase("pt-BR");
  return (lower.charAt(0).toLocaleUpperCase("pt-BR") + lower.slice(1)).replace(/\bhtml\b/, "HTML");
}

function plainList(list) {
  return list.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

function inExecution(list) {
  return plainList(list) === "em execucao";
}

function inAdjustments(list) {
  return plainList(list) === "alteracoes";
}

function inPause(list) {
  return plainList(list) === "em pausa";
}

function inQueue(list) {
  return inAdjustments(list) || inPause(list);
}

function columnStayLabel(list) {
  if (inPause(list)) return "Em pausa (relógio parado)";
  if (inAdjustments(list)) return "Na fila de Alterações (não conta como hora trabalhada)";
  if (inExecution(list)) return "Em execução";
  return `Na coluna ${list}`;
}

function deliveryText(deck) {
  if (!deck) return "Sem medida de entrega";
  if (deck.access === "fechada") return "Link fechado";
  if (deck.access === "sem-link") return "Sem apresentação";
  if (deck.deliveryPercent == null) return "Selo de aprovação ainda não lido";
  return `${deck.deliveredPosts} de ${deck.posts} posts com o selo de aprovação`;
}

function when(iso) {
  if (!iso) return "ainda não sincronizou";
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(iso));
}

function Deadline({ card }) {
  if (!card.due) return <div className="deadline-none">Sem prazo no card</div>;
  const now = Date.now();
  const due = Date.parse(card.due);
  const start = Date.parse(card.assignedAt || "");
  const late = now > due;
  const share = late ? 100 : Number.isFinite(start) && due > start ? Math.min(100, Math.max(0, ((now - start) / (due - start)) * 100)) : 0;
  return (
    <div className="deadline">
      <div className="time">
        <span>Entrega {when(card.due)}</span>
        <div className={late ? "track late" : "track"}><i style={{ width: `${share}%` }} /></div>
        <b className={late ? "late" : ""}>{late ? `atrasada há ${span((now - due) / 3600000)}` : `faltam ${span((due - now) / 3600000)}`}</b>
      </div>
    </div>
  );
}

function CardPiece({ card }) {
  const measured = card.deck?.routine && card.deck.deliveryPercent != null;
  return (
    <div className={measured ? "piece" : "piece plain"}>
      {measured && (
        <div className="ring" style={{ "--p": card.deck.deliveryPercent }}>
          <span>{card.deck.deliveryPercent}%</span>
        </div>
      )}
      <div>
        <a href={card.url}>{card.name}</a>
        <div className="quiet">{card.client}</div>
        {card.deck?.routine && <div className="quiet">{deliveryText(card.deck)}</div>}
        {card.deck?.routine && card.deck.pace && <div className={`pace ${card.deck.pace.status}`}>{card.deck.pace.text}</div>}
        <div className="quiet">{columnStayLabel(card.list)} há {span(card.hoursInList)}</div>
        <Deadline card={card} />
      </div>
    </div>
  );
}

function Entrega({ data, focus, onFocus }) {
  const people = data.das
    .map((item) => ({
      ...item,
      doing: item.cards.filter((card) => inExecution(card.list)),
      queued: item.cards.filter((card) => inQueue(card.list)),
    }))
    .filter((item) => item.doing.length || item.queued.length);
  const shown = people.find((item) => item.name === focus) || people[0];
  if (!shown) return <p className="quiet">Nenhuma task em execução, pausa ou alterações.</p>;
  return (
    <section>
      <h2>Em trabalho</h2>
      <nav className="subnav">
        {people.map((item) => (
          <button key={item.name} className={item.name === shown.name ? "on" : ""} onClick={() => onFocus(item.name)}>
            {first(item.name)}
            <small>{item.doing.length} em execução{item.queued.length ? ` · ${item.queued.length} na fila` : ""}</small>
          </button>
        ))}
      </nav>
      <article className="stage">
        <h3>{displayName(shown.name)}{!shown.active && <span className="tag"> {shown.note}</span>}</h3>
        {shown.doing.length > 0 && (
          <>
            <p className="quiet" style={{ marginTop: 0 }}>Em execução — só esta coluna conta no tempo do cliente.</p>
            {shown.doing.map((card) => <CardPiece key={card.id} card={card} />)}
          </>
        )}
        {shown.queued.length > 0 && (
          <>
            <p className="quiet" style={{ marginTop: shown.doing.length ? 18 : 0 }}>
              Na fila — Alterações e Em pausa não entram nas horas trabalhadas.
            </p>
            {shown.queued.map((card) => <CardPiece key={card.id} card={card} />)}
          </>
        )}
        <p className="quiet stage-note">A barra vai do dia em que o DA foi marcado no cartão até a data de entrega. Cheia, o prazo chegou; rosa, passou do prazo. Para o relógio bater certo: mover para Em execução ao começar, para Em pausa ao parar (almoço, outra task) e para Alterações quando estiver só aguardando retorno — sem contar tempo.</p>
      </article>
    </section>
  );
}

export function App() {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [view, setView] = useState(() => {
    const hash = location.hash.replace("#", "");
    return VIEWS.some(([id]) => id === hash) ? hash : "entrega";
  });
  const [syncing, setSyncing] = useState(false);
  const [notice, setNotice] = useState("");
  const [person, setPerson] = useState(null);
  const [focus, setFocus] = useState(null);
  const [locked, setLocked] = useState(STATIC ? null : false);

  async function load() {
    if (STATIC) {
      const body = await unlockWithSaved();
      if (!body) {
        setData(null);
        setLocked(true);
        return;
      }
      apply(body);
      return;
    }
    const response = await fetch("/api/dashboard");
    if (response.status === 401) {
      location.href = "/entrar";
      return;
    }
    if (!response.ok) throw new Error("Não foi possível ler o painel");
    apply(await response.json());
  }

  function apply(body) {
    setData(body);
    setLocked(false);
    setPerson((current) => current || body.das.find((item) => item.active)?.name || null);
    setFocus((current) => {
      const eligible = body.das.filter((item) =>
        item.cards.some((card) => inExecution(card.list) || inQueue(card.list)),
      );
      if (current && eligible.some((item) => item.name === current)) return current;
      return eligible[0]?.name || null;
    });
  }

  useEffect(() => {
    load().catch((reason) => setError(reason.message));
    const timer = setInterval(() => load().catch(() => {}), STATIC ? 300000 : 60000);
    return () => clearInterval(timer);
  }, []);

  async function sync() {
    setSyncing(true);
    setNotice("");
    try {
      const response = await fetch("/api/sync", { method: "POST" });
      if (response.status === 401) {
        location.href = "/entrar";
        return;
      }
      const body = await response.json();
      if (body.dashboard) setData(body.dashboard);
      setNotice(body.ok ? "Quadro atualizado." : body.reason);
    } catch (reason) {
      setNotice(reason.message);
    } finally {
      setSyncing(false);
    }
  }

  const maxCards = useMemo(
    () => Math.max(1, ...(data?.das.map((item) => item.openCards) || [1])),
    [data],
  );
  const maxColumn = useMemo(
    () => Math.max(1, ...(data?.columns.map((item) => item.openCount) || [1])),
    [data],
  );

  if (error) return <main className="wrap"><p>{error}</p></main>;
  if (locked) return <Gate onUnlock={apply} />;
  if (!data) return <main className="wrap"><p>Lendo o quadro…</p></main>;

  const selected = data.das.find((item) => item.name === person);

  return (
    <>
    <header className="mast">
      <strong>{(data.brand || "").toLocaleUpperCase("pt-BR")}</strong>
      <span>Painel de criação</span>
      <span>{new Date(data.generatedAt).getFullYear()}</span>
    </header>
    <div className="stripe" />
    <main className="wrap">
      <header className="top">
        <p className="kicker" style={{ margin: 0 }}>Quadro {data.boardName}</p>
        <div className="actions">
          {STATIC ? (
            <button className="ghost" onClick={() => { forget(); setData(null); setLocked(true); }}>Sair</button>
          ) : (
            <button onClick={sync} disabled={syncing}>{syncing ? "Atualizando…" : "Atualizar agora"}</button>
          )}
          <p className="meta">Leitura de {when(data.syncedAt)}{STATIC ? " · atualiza a cada 15 minutos" : ""}</p>
        </div>
      </header>

      {data.source === "vazio" && (
        <div className="banner">
          <strong>Lendo o Trello pela primeira vez.</strong> Leva cerca de dois minutos; depois, clique em atualizar.
        </div>
      )}
      {notice && <p className="meta" style={{ marginTop: 12 }}>{notice}</p>}

      <nav className="nav">
        {VIEWS.map(([id, label]) => (
          <button key={id} className={view === id ? "on" : ""} onClick={() => { setView(id); history.replaceState(null, "", `#${id}`); }}>{label}</button>
        ))}
      </nav>

      {view === "mesa" && (
        <>
        <h1>Onde a fila está parada</h1>
        <p className="lede">{data.reading}</p>
        <section className="kpis">
          {data.kpis.map((item) => (
            <article className="kpi" key={item.label}>
              <b className="num">{item.value}</b>
              {item.label}
              <span>{item.detail}</span>
            </article>
          ))}
        </section>
        <section className="grid-2" style={{ marginTop: 28 }}>
          <div>
            <h2>Leitura da fila</h2>
            {data.arguments.map((item) => (
              <article className="argument" key={item.title}>
                <h3>{item.title}</h3>
                <p>{item.text}</p>
              </article>
            ))}
          </div>
          <div>
            <h2>Carga na casa</h2>
            <table>
              <thead>
                <tr><th>DA</th><th className="right">Cartões</th><th className="right">Clientes</th></tr>
              </thead>
              <tbody>
                {data.das.filter((item) => item.active || item.openCards || item.withClient).map((item) => (
                  <tr key={item.name}>
                    <td>
                      {first(item.name)}
                      {!item.active && <div className="tag">{item.note}</div>}
                      <div className={item.overLimit ? "bar hot" : "bar"}><i style={{ width: `${(item.openCards / maxCards) * 100}%` }} /></div>
                    </td>
                    <td className="right">{item.openCards}</td>
                    <td className="right">{item.clientCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="quiet" style={{ marginTop: 8 }}>Limite deste painel: {data.wipLimit} cartões por DA. A barra conta o que ainda está na casa.</p>
          </div>
        </section>
        </>
      )}

      {view === "entrega" && (
        <Entrega data={data} focus={focus} onFocus={setFocus} />
      )}

      {view === "pessoas" && (
        <section>
          <table>
            <thead>
              <tr>
                <th>DA</th>
                <th className="right">Na casa</th>
                <th className="right">No cliente</th>
                <th className="right">Média na task</th>
                <th className="right">Clientes agora</th>
              </tr>
            </thead>
            <tbody>
              {data.das.map((item) => (
                <tr key={item.name} className={item.name === person ? "on click" : "click"} onClick={() => setPerson(item.name)}>
                  <td>{displayName(item.name)}{!item.active && <div className="tag">{item.note}</div>}</td>
                  <td className="right">{item.openCards}</td>
                  <td className="right">{item.withClient}</td>
                  <td className="right">{span(item.avgHoursOnCard)}</td>
                  <td className="right">{item.clientCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {selected && (
            <article className="person">
              <h2>{displayName(selected.name)}</h2>
              <p>
                {selected.clientCount
                  ? `Trabalhando agora em ${selected.clients.join(", ")}.`
                  : "Nenhum cartão na casa."}
                {selected.markedClientCount > selected.clientCount
                  ? ` Ainda marcado em ${selected.markedClientCount} clientes, contando o que já está com o cliente.`
                  : ""}
              </p>
              <table>
                <thead>
                  <tr><th>Task</th><th>Coluna</th><th className="right">Na task</th><th className="right">Na coluna</th></tr>
                </thead>
                <tbody>
                  {selected.cards.map((card) => (
                    <tr key={card.id}>
                      <td><a href={card.url}>{card.name}</a><div className="quiet">{card.client} · {card.dueLabel}</div>{card.deck ? <div className="quiet">{card.deck.summary}</div> : null}</td>
                      <td>{card.list}</td>
                      <td className="right">{span(card.hoursOnCard)}</td>
                      <td className="right">{span(card.hoursInList)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="quiet" style={{ marginTop: 10 }}>Na task conta desde a última marcação. Na coluna conta desde que o cartão entrou na lista, mesmo que a pessoa tenha sido marcada depois. Numa rotina com link aberto, o post conta como aprovado quando o triângulo rosa que abre a pasta de atributos está no slide. O último post do calendário não é a data em que o DA entregou.</p>
            </article>
          )}
        </section>
      )}

      {view === "colunas" && (
        <section>
          <h2>Tempo em cada coluna</h2>
          <p className="lede">Quantos cartões estão em cada coluna agora, há quanto tempo eles estão lá e quanto tempo um cartão costuma ficar nessa coluna antes de seguir.</p>
          <table style={{ marginTop: 18 }}>
            <thead>
              <tr>
                <th>Coluna</th>
                <th className="right">Cartões agora</th>
                <th className="right">Média de quem está lá agora</th>
                <th className="right">Média de quem já passou</th>
              </tr>
            </thead>
            <tbody>
              {data.columns.map((column) => (
                <tr key={column.name}>
                  <td>
                    {listLabel(column.name)}
                    <div className={column.name.includes("CLIENTE") ? "bar wait" : "bar"}><i style={{ width: `${(column.openCount / maxColumn) * 100}%` }} /></div>
                  </td>
                  <td className="right">{column.openCount}</td>
                  <td className="right">{column.openCount ? (column.avgHoursOpen == null ? "sem data" : span(column.avgHoursOpen)) : "—"}</td>
                  <td className="right">{column.sampleCompleted ? span(column.avgHoursCompleted) : "sem histórico"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="quiet" style={{ marginTop: 8 }}>Média de quem está lá agora: há quanto tempo os cartões atuais estão parados na coluna, contando até hoje. Média de quem já passou: quanto tempo ficaram, nos últimos meses, os cartões que já saíram dessa coluna.</p>
          <h2 style={{ marginTop: 28 }}>Por atendimento</h2>
          <p className="lede">Um cartão com três pessoas de atendimento entra na conta das três. O tempo é o que a task já ficou na coluna. {shorts((data.roster?.socios || []).map((person) => person.name)).join(", ")} entram como sócios e {(data.roster?.trafego || []).map((person) => first(person.name)).join(", ")} como tráfego, fora desta conta.</p>
          <table>
            <thead>
              <tr><th>Atendimento</th><th>Cartões</th><th>Clientes</th><th>Onde o tempo está</th></tr>
            </thead>
            <tbody>
              {data.atendimento.filter((item) => item.openCards).map((item) => (
                <tr key={item.name}>
                  <td>{item.name}</td>
                  <td>{item.openCards}</td>
                  <td>{item.clients.length}</td>
                  <td>{item.byColumn.map((column) => `${title(column.name)} ${column.count} (${span(column.avgHours)})`).join(" · ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {view === "clientes" && (
        <section>
          {data.clientTime && (
            <>
              <h2>Tempo das tasks em execução, por cliente</h2>
              <p className="lede">Quanto tempo as tasks de cada cliente ficaram na coluna Em execução do Trello no mês. Alterações e Em pausa não entram nesta conta. É o tempo do cartão na coluna, não as horas exatas que o DA trabalhou nele. O número principal conta só horas úteis; embaixo, o tempo corrido, com noites e fins de semana.</p>
              <div className="callout">
                <b>Quanto melhor o uso das colunas, mais perto da hora real.</b> Levar o cartão para Em execução ao começar e tirar de lá ao parar (Em pausa), deixar em Alterações ou entregar deixa este número cada vez mais próximo das horas de fato trabalhadas.
              </div>
              <table style={{ marginTop: 18, marginBottom: 8 }}>
                <thead>
                  <tr>
                    <th>Cliente</th>
                    <th className="right">{capital(data.clientTime.currentLabel)}, até hoje</th>
                    <th className="right">{capital(data.clientTime.previousLabel)}</th>
                    <th className="right">Média por mês</th>
                  </tr>
                </thead>
                <tbody>
                  {data.clientTime.clients.map((item) => (
                    <tr key={item.name}>
                      <td>{item.name}</td>
                      <PeriodCell value={item.current} />
                      <PeriodCell value={item.previous} />
                      <PeriodCell value={item.average} average />
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="quiet" style={{ marginBottom: 32 }}>
                {data.clientTime.averageLabel
                  ? `A média usa os meses completos de ${data.clientTime.averageLabel}.`
                  : "Ainda não há um mês completo de histórico para a média."}{" "}
                Horas úteis: segunda a sexta, das 9h às 18h, com uma hora de almoço; um dia útil são 8 horas. Feriados não são descontados. Cartão com dois DAs conta uma vez, e é tempo de cartão na coluna, não hora trabalhada.
              </p>
            </>
          )}
          <h2>Clientes na fila</h2>
          <table>
            <thead>
              <tr><th>Cliente</th><th className="right">Abertos</th><th className="right">Na casa</th><th>DAs</th><th>Atendimento</th><th className="right">Média na casa</th></tr>
            </thead>
            <tbody>
              {data.clients.map((item) => (
                <tr key={item.name}>
                  <td>{item.name}</td>
                  <td className="right">{item.openCards}</td>
                  <td className="right">{item.inHouse}</td>
                  <td>{shorts(item.das).join(", ") || "—"}</td>
                  <td>{shorts(item.atendimento).join(", ") || "—"}</td>
                  <td className="right">{item.avgHoursInHouse == null ? "sem histórico" : `${span(item.avgHoursInHouse)}${item.houseTimed < item.inHouse ? ` · ${item.houseTimed} de ${item.inHouse} com data` : ""}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {data.noDa.length > 0 && (
            <>
              <h2 style={{ marginTop: 28 }}>Na casa sem DA ativo</h2>
              <table>
                <thead><tr><th>Cartão</th><th>Cliente</th><th>Coluna</th><th>Prazo</th></tr></thead>
                <tbody>
                  {data.noDa.map((card) => (
                    <tr key={card.name}><td><a href={card.url}>{card.name}</a></td><td>{card.client}</td><td>{card.list}</td><td>{card.dueLabel}</td></tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </section>
      )}
      {data.tagline && <footer className="foot">{data.tagline}</footer>}
    </main>
    </>
  );
}

function title(name) {
  return name.charAt(0) + name.slice(1).toLowerCase();
}
