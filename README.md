# Painel de criação

Dashboard de um quadro do Trello para ver o que cada pessoa da criação está fazendo, há quanto tempo, em quantos clientes, e quanto tempo cada task fica em cada coluna.

O número que o Trello sustenta é **tempo de fila**: desde que a pessoa foi marcada e desde que o cartão entrou na coluna. Não é hora trabalhada.

## O que aparece

- **Entrega:** o que cada DA tem em execução e em alterações, com a porcentagem das rotinas que já têm o selo de aprovação na apresentação.
- **Pessoas:** carga, clientes e tempo de cada DA por task.
- **Colunas:** quantos cartões estão em cada coluna, há quanto tempo e quanto um cartão costuma ficar.
- **Clientes:** tasks e tempo de execução e alterações por cliente, em horas úteis e corridas, no mês atual, no anterior e na média mensal.
- **Mesa:** resumo da fila, com os números principais e uma leitura escrita a partir deles.

## Configuração

Nada da equipe fica no código. Equipe, marca, nomes de clientes e colunas ficam em `config/team.json`, que não vai para o git. Copie `config/team.example.json` e preencha.

Chaves e senha ficam no `.env` (copie `.env.example`), que também não vai para o git:

- `TRELLO_KEY` e `TRELLO_TOKEN`: acesso de leitura ao Trello.
- `TRELLO_BOARD_ID`: o quadro lido.
- `PAINEL_SENHA`: senha do painel publicado.

## Rodar no computador

Precisa de Node 22.13 ou mais novo.

```bash
npm install
npm run build
npm start
```

O painel abre em `http://127.0.0.1:8787`, busca o Trello a cada 15 minutos e tem o botão **Atualizar agora**. Com `PAINEL_SENHA` preenchida, pede a senha antes de abrir.

## Publicar no GitHub Pages

O workflow `.github/workflows/publicar.yml` roda a cada 15 minutos: lê o Trello, monta o painel e publica no GitHub Pages. Os dados vão **criptografados** (AES-256-GCM, chave derivada da senha com PBKDF2). A página pede a senha e abre os dados no navegador; sem a senha, o arquivo publicado é ilegível.

1. Em **Settings > Secrets and variables > Actions**, crie os segredos `TRELLO_KEY`, `TRELLO_TOKEN`, `TRELLO_BOARD_ID`, `PAINEL_SENHA` e `TEAM_JSON` (o conteúdo inteiro do `config/team.json`).
2. Em **Settings > Pages**, escolha **GitHub Actions** como origem.
3. Em **Actions > Publicar painel**, clique em **Run workflow**.

A senha precisa ter pelo menos 16 caracteres; quatro ou cinco palavras aleatórias funcionam bem. Quem entra fica conectado naquele navegador até clicar em **Sair**. Trocar a senha desconecta todo mundo na publicação seguinte.

Na versão publicada não há botão de atualizar: ela mostra a hora da última leitura.

## Desenvolvimento

Em um terminal, `npm start`. Em outro, `npm run client`. O Vite abre em `http://127.0.0.1:5173` e encaminha `/api` para o servidor.
