# Revisão de vídeo

A campanha pode pedir roteiro, vídeo, capa e legenda. Aprovar o vídeo cedo demais libera a entrega sem o que a marca comprou. Aqui a entrega só é aprovada quando cada peça que a campanha exige tem a versão atual aprovada. O upload é só uma URL; a regra é de verdade.

Comece a leitura por [`src/rules.ts`](src/rules.ts): `pendingRequired(required, currentByKind)` é a regra inteira da aprovação. `src/review.ts` aplica a regra com o banco; a rota só repassa.

## Regras

- Peças: `script`, `video`, `cover`, `caption`. A campanha guarda a lista exigida em `required_json`.
- `pendingRequired` devolve as exigidas cuja versão atual não está `approved`. Peça não exigida não entra, mesmo se existir pendente.
- Versão: `number` crescente por `(entrega, peça)`, `url`, status `pending` ou `approved`.
- Versão nova nasce `pending` e vira a atual. A anterior fica, com os comentários dela. Comentário não é copiado. Se a entrega estava `approved`, volta para `in_production`.
- Aprovar uma versão que não é a atual → 409.
- Aprovar a entrega com peça exigida pendente → `409 {"error":"peça obrigatória sem versão aprovada","pending":[...]}`. Sem pendência → `approved`.
- Comentário: `at_second` inteiro `>= 0` e `body`.

## API

```text
POST /campaigns                              {"required":["video","cover"]}
POST /deliveries                             {"campaign_id":"..."}
POST /deliveries/:id/pieces/:kind/versions   {"url":"https://cdn.exemplo/v1.mp4"}
POST /versions/:id/comments                  {"at_second":12,"body":"corta o logo"}
POST /versions/:id/approval
POST /deliveries/:id/approval
GET  /deliveries/:id
GET  /versions/:id                           comentários da versão, com at_second
```

## Como rodar

Node 22.13 ou maior (primeira versão com `node:sqlite` sem flag).

```bash
npm install
npm test
npm run typecheck
npm run dev
```

A API sobe em `http://127.0.0.1:43126`.

## Exemplo: vídeo aprovado, capa faltando

O teste `campanha exige vídeo e capa: só o vídeo aprovado, a entrega volta 409 com pending [cover]` executa estes requests.

```bash
API=http://127.0.0.1:43126
curl -s -X POST $API/campaigns -H 'content-type: application/json' -d '{"required":["video","cover"]}'
# guarde o "id" em CMP
curl -s -X POST $API/deliveries -H 'content-type: application/json' -d "{\"campaign_id\":\"$CMP\"}"
# guarde o "id" em DLV
curl -s -X POST $API/deliveries/$DLV/pieces/video/versions -H 'content-type: application/json' \
  -d '{"url":"https://cdn.exemplo/v1.mp4"}'
# guarde o "id" em VER
curl -s -X POST $API/versions/$VER/approval
curl -s -X POST $API/deliveries/$DLV/approval
```

Última resposta, `409`:

```json
{ "error": "peça obrigatória sem versão aprovada", "pending": ["cover"] }
```

`GET /versions/$VER` depois de `POST /versions/$VER/comments` com `{"at_second":12,"body":"corta o logo"}` (ids variam):

```json
{
  "id": "ver_99b141dc-fb5c-4a48-a707-732539cbb6d7",
  "delivery_id": "dlv_bc82f50d-7dc7-4863-ad81-6f728dfa0146",
  "kind": "video",
  "number": 1,
  "url": "https://cdn.exemplo/v1.mp4",
  "status": "approved",
  "current": true,
  "comments": [{ "id": "cmt_10046301-8527-4a54-91ae-c2afe42f6c9e", "at_second": 12, "body": "corta o logo" }]
}
```

## Ficou de fora

Transcodificação e mais de um revisor.

## Nota da entrega

Comece por `src/rules.ts`. A aprovação da entrega é uma função só, `pendingRequired`: pega as peças que a campanha exige e devolve as que não têm a versão atual aprovada. Se a lista não for vazia, a entrega volta 409 com `pending`, então a marca vê o que falta (`["cover"]`) em vez de um erro genérico. Peça não exigida não trava: campanha só de vídeo aprova com roteiro pendente. Versão nova nasce pendente, vira a atual, não herda comentário e devolve a entrega aprovada para `in_production`; aprovar a versão antiga depois disso é 409. Comentário fica preso à versão, com o segundo do vídeo.

Testes: `npm test` com 7 passando, `npm run typecheck` sem erro. O exemplo deste README é o request do teste da capa faltando.

Ficou de fora: transcodificação e mais de um revisor.

IA: código, testes e README escritos com assistente de código (Claude Code), a partir de um plano com as regras do desafio. O assistente rodou os testes e o typecheck e colou a resposta real acima.
