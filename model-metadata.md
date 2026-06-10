# Métadonnées de modèles — registre éditable adossé à models.dev

> **Statut : IMPLÉMENTÉ (phases 0→4) et activé par défaut (2026-06-10).**
> Le registre (`model_registry`) est la source de vérité des métadonnées modèle,
> seedé depuis models.dev + éditable dans Réglages › « Registre de modèles ».
> Flag `HIVEKEEP_MODEL_REGISTRY` (ON par défaut ; `=false` pour le legacy).
> Code : `src/server/llm/metadata/`, `src/server/services/model-registry.ts`,
> `src/server/routes/models.ts`, `src/client/pages/settings/ModelRegistrySettings.tsx`,
> snapshot `src/server/llm/metadata/models-dev-snapshot.json` (script
> `scripts/fetch-models-dev.ts`), diagnostic `scripts/test-model-mapping.ts`.
> Reste optionnel (la donnée est exposée, consommateurs faciles) : gating upload
> image/PDF, dashboard de coûts, repointage du model-picker sur le registre.

## 1. Le problème

Les bugs récents sur les providers ont la **même cause racine** :

- DeepSeek : contexte câblé à 128k alors que V4 fait **1M**.
- MiniMax-M3 : **vision** non détectée (modèle multimodal classé text-only).
- DeepSeek/Kimi : capacités de **reasoning** devinées au nom du modèle.

À chaque fois, on **maintient à la main des métadonnées statiques** via des
heuristiques sur l'`id` (`CONTEXT_BY_PREFIX`, `inferThinking`,
`inferImageInput`…). Ça **dérive** dès qu'un provider change son catalogue, et
l'API `/models` de la plupart des providers ne renvoie que des ids.

### Un provider fait deux métiers (qu'on a mélangés)

| Métier | Exemples | Dérive ? | Sort vers models.dev ? |
|---|---|---|---|
| **Métadonnées catalogue** | contexte, modalités (image/pdf), reasoning, prix, max output | **oui** (tous les bugs) | **oui** |
| **Transport / comportement** | streaming, conversion des messages, **replay de `reasoning_content`**, parsing `<think>`, mapping d'erreurs, auth, base URL | non | **non** — reste dans le provider |

> Le transport reste **dans le provider** : c'est son vrai métier, et models.dev
> ne le résout pas (consensus). On ne sort que les **métadonnées catalogue**.

## 2. models.dev (vérifié le 2026-06-09)

- **Licence MIT** ([anomalyco/models.dev](https://github.com/sst/models.dev),
  ~4 900 ★, actif) → on peut **embarquer la donnée** librement.
- Distribution : **JSON statiques** (pas de package npm).
  - `api.json` — provider + service (prix inclus), 2,2 Mo, 140 providers.
    **C'est celui qu'on utilise** (clé `[provider][models][modelId]`).
  - `models.json` — faits modèle « provider-agnostic » (208).
- Champs par modèle : `limit.context/output`, `modalities.input/output`
  (vocabulaire **`text, image, pdf, audio, video`**), `reasoning` +
  `reasoning_options` (toggle / effort + valeurs), `interleaved.field`,
  `tool_call`, `cost` (input/output/cache), `knowledge`, `release_date`.
- Couverture : deepseek (4), minimax (7), moonshotai/kimi (7), openai (50),
  anthropic (25), google (22), xai (8), openrouter (341)…

**Preuve que ça aide** : models.dev donne `deepseek-v4-flash` → `1000000` +
`input:[text]`, et `MiniMax-M3` → `input:[text,image,video]`. **2 de mes 3 bugs
corrects d'office.** (Nuance : il annonce M3 à **512k** vs 1M ailleurs — la
donnée reste une source faillible mais **corrigée par la communauté**, d'où la
possibilité d'override admin ci-dessous.)

## 3. Ce que ça débloque (bénéfices)

- **Contrat provider plus léger** : moins de métadonnées à exposer/maintenir.
- **Prix** → estimation des dépenses (coût par Agent / par modèle).
- **Contexte** → budget de contexte / compacting fiable.
- **Capacités (modalités)** → activer/désactiver l'upload selon le modèle
  (image, PDF) ; afficher le sélecteur de reasoning ; couper les tools si pas de
  tool-call.

Ce que ça **ne résout pas** : le **transport** (replay `reasoning_content` sur
tool-call = le vrai 400 prod, parsing `<think>`, erreurs…) reste du code
provider, plus mince.

## 4. Architecture retenue : un registre de modèles en base (source de vérité)

**Décision (fondateur, 2026-06-09)** — plutôt qu'un resolver purement code,
Hivekeep possède un **registre de modèles persistant**, **source de vérité** pour
les métadonnées, **auto-rempli depuis models.dev** mais **éditable par l'admin**.

- Chaque modèle exposé par un provider activé = **une ligne** en base.
- À la découverte (`listModels`), un **algorithme de matching** associe
  `(provider, modelId)` à une entrée models.dev et **auto-complète** contexte,
  prix, modalités, reasoning, tool_call…
- L'admin peut : **corriger le mapping** (Hivekeep ↔ models.dev),
  **éditer/épingler des champs**, ou passer le modèle en **manuel** (saisie
  complète).
- Cette base — enrichie **par la communauté (models.dev) ET par l'admin** — est
  consommée partout (cf. §9).

### Le contrat provider maigrit
`LLMProvider.listModels` ne renvoie plus que des **ids** (+ éventuellement les
métadonnées que SON API expose vraiment, en simple *indice de seed* : ex.
Moonshot `context_length`). On **supprime** `CONTEXT_BY_PREFIX`, `inferThinking`,
`inferImageInput` des providers. Le **transport reste**.

## 5. Schéma DB (proposition, à affiner avec `schema.md`)

Table `models` :
- `id` (uuid), `provider_id` (FK config provider), `model_id` (id upstream),
  `display_name`
- `mapping_mode` : `auto` | `manual`
- `models_dev_key` (clé matchée, nullable) + `match_confidence`
- `context_window`, `max_output`
- `supports_tool_call`, `reasoning` (json : `enabled` + `efforts`)
- modalités : `supports_image_input`, `supports_pdf_input` (audio/video plus tard)
- `pricing` (json : input/output/cache_read/cache_write)
- `overridden_fields` (json : champs épinglés par l'admin)
- `enabled` (proposer ce modèle ou non), timestamps

Le **snapshot models.dev** est **embarqué** (JSON vendu), pas en DB.

## 6. Algorithme de matching (Hivekeep ↔ models.dev)

1. Mapper `provider.type` → id models.dev (table : `moonshot`→`moonshotai`,
   `gemini`→`google`, sinon identité).
2. Match **exact** d'`model_id` (insensible à la casse) dans ce provider.
3. Sinon **normaliser** (minuscules, séparateurs, retrait de `-latest`/dates) + match.
4. Sinon match par `family` / alias, avec **score de confiance**.
5. Score faible / pas de match → ligne **non mappée** : défauts sûrs + **flag
   « à vérifier »** dans la vue Models (l'admin mappe ou passe en manuel).

Le matching s'applique **au seed** et **aux refresh** des lignes `auto`
(jamais sur les champs épinglés ni les lignes manuelles).

### Découverte continue (auto-mapping des nouveaux modèles)

À **chaque `listModels`** (activation d'un provider, démarrage, cron, ou
« resync » manuel), on **réconcilie** la liste d'ids live ↔ les lignes en base :

- **id inconnu** (le provider a ajouté un modèle) → on **crée une ligne en mode
  `auto`** et on lance le matching **best-effort** (auto-pick du meilleur
  candidat models.dev ; si confiance faible → flag « à vérifier »). Le nouveau
  modèle est donc **utilisable immédiatement** avec des métadonnées plausibles,
  sans intervention.
- **id déjà connu** → on **ne touche pas** la ligne (overrides épinglés et mode
  `manuel` préservés ; les champs `auto` non épinglés peuvent se resync).
- **id disparu** de l'API → on marque la ligne `enabled=false` / « obsolète »
  (on ne supprime pas, pour préserver un éventuel override si le modèle revient).

## 7. Sync & override (la règle d'or)

Priorité **par champ** :
**override admin (épinglé) > models.dev (si `auto`) > indice API provider > défaut heuristique**.

- `auto` : les champs **non épinglés** se re-synchronisent au refresh du snapshot.
- champ édité par l'admin → **épinglé** (survit aux refresh).
- `manual` : ligne entièrement figée (saisie admin).

## 8. Vue « Models » (UI)

- Un grand **tableau** listant tous les modèles de tous les providers activés.
- Colonnes éditables : contexte, max output, prix, image, PDF, tool_call, reasoning.
- Par ligne : badge `auto`/`manuel`, modèle models.dev matché (+ confiance),
  actions **« remapper »**, **« passer en manuel »**, **« resync »**.
- **Emplacement** : à trancher — section dans les **Réglages** (admin) *(reco,
  cohérent avec la config providers)* vs **page dédiée**.

## 9. Points de consommation (où la DB devient source de vérité)

- **Budget de contexte / compacting** : `context_window`.
- **Gating upload** : `supports_image_input` / `supports_pdf_input` →
  activer/désactiver l'upload d'images / PDF dans le chat.
- **Reasoning** : `reasoning.enabled/efforts` → sélecteur d'effort.
- **Tool calls** : `supports_tool_call` (→ `maxTools` 0) → couper tools + sections de prompt.
- **Dépenses** : `pricing` × usage → coût par Agent / par modèle.

## 10. Décisions actées (2026-06-09)

1. **Override : par-champ épinglé.** Le modèle reste `auto` (resync models.dev) ;
   chaque champ édité par l'admin devient **épinglé** et survit aux refresh.
   `manual` = ligne entièrement figée. → `overridden_fields` (json) dans le schéma.
2. **UI : section dans les Réglages** (admin), cohérent avec la config providers.
3. **Non-mappés : auto-pick + flag « à vérifier ».** On choisit le meilleur
   candidat et on marque la ligne pour validation ; le modèle marche tout de
   suite avec des données plausibles.
4. **Refresh : cron auto (configurable) + bouton resync, sur un snapshot
   embarqué de base.** Le snapshot vendu garantit le 1er boot offline ; un cron
   (intervalle réglable) et un bouton « resync » dans la vue Models récupèrent
   une version plus récente de models.dev par-dessus. Les champs épinglés /
   lignes manuelles ne sont jamais écrasés.

## 11. Plan de migration (incrémental, réversible)

1. Snapshot embarqué + script de build (fetch + trim `api.json`).
2. Schéma `models` + repository + `resolveModelMetadata` (matching + sync §6/§7).
3. Refresh : cron configurable + endpoint/bouton « resync ».
4. Vue Models (Réglages) : tableau éditable + remap + manuel + resync.
5. Brancher les **consommateurs** (§9) sur la DB : contexte, gating upload
   image/PDF, reasoning, tools, dépenses.
6. Migrer **un provider à la fois** (DeepSeek/MiniMax → xAI → Moonshot →
   OpenRouter) : retirer les heuristiques, **transport intact**.

## 12. Analyse d'impact (sur le code réel, 2026-06-09)

### Le point rassurant : back-compat plugins quasi gratuite
- `LLMModel` (`packages/sdk/src/index.ts:789-842`) a **déjà tous ses champs
  optionnels**. On **ne narrow PAS** le type de retour de `listModels`
  (`Promise<LLMModel[]>`) : un plugin qui renvoie des métadonnées **continue de
  marcher**, ses valeurs deviennent juste un **indice de seed basse priorité**
  (§7). Narrow en « ids-only » serait le **seul** vrai breaking (réécriture de
  tous les plugins LLM + tuto Mistral + `example.test.ts`) → **à éviter**.
- Additif sûr : **ajouter `supportsPdfInput`** à `LLMModel` (bump mineur).
- Les plugins **peuvent** définir des providers LLM (`plugins.ts:1015`
  `registerLLMProvider`, testé `plugins-e2e.test.ts:178`). Leurs ids n'existent
  pas dans models.dev → branche « non-mappé → auto-pick + flag » (§6) ; le
  matching `type → id models.dev` doit **no-matcher proprement** sur `plugin:*`.

### L'invariant critique (gouverne l'ordre de migration)
L'objet `LLMModel` de `listModels()` est passé **verbatim** à `provider.chat()`
via le SEAM `src/server/llm/core/resolve.ts:45-52, 83, 103-104, 129-131`.
`chat()` lit `model.thinking?.efforts` (gate `reasoning_effort`, **6 providers**
+ `_anthropic-shared.ts:225`), `model.maxOutput` (anthropic clampe à 4096 sinon),
`model.maxTools` (tool-cap → 128 sinon). **Donc on ne peut pas amincir un
provider tant que `resolve.ts` ne ré-enrichit pas le modèle depuis le registre.**
→ **brancher la lecture DB AVANT de retirer les heuristiques.**

### Deux chokepoints à brancher (sources distinctes aujourd'hui)
1. **`resolve.ts`** → `resolved.model` pour `chat()` (thinking/maxOutput/maxTools/image).
2. **`model-info-cache.ts` + `getModelContextWindow`** (`src/shared/model-context-windows.ts:27`)
   pour le `contextWindow` (compacting ×4, context-preview ×3, agent-engine).
   ⚠️ `shared/` **ne doit pas** importer le serveur/DB → garder l'injection
   `setModelInfoLookup`. Signature **provider-aveugle** `(modelId)` → ambiguïté
   si 2 providers exposent le même id (ex. `gpt-5` via key ET codex).

### Tous les providers ne sont PAS égaux (ne pas régresser la qualité)
| Provider | À faire |
|---|---|
| **deepseek, minimax** | 100% nominal → vrais candidats « ids seuls » : supprimer tous les `inferX`. |
| **moonshot** | Garder `context_length`/`supports_image_in`/`supports_reasoning` (API réelle) comme **seed prioritaire** ; virer les fallbacks nominaux. |
| **xai** | Garder `pricing`/`input_modalities` (API) ; virer contexte/thinking nominaux. |
| **gemini** | Garder `inputTokenLimit`/`outputTokenLimit` (API) ; virer vision/thinking nominaux. |
| **openrouter** | **Gold standard** (tout vient de l'API) → transformer `inferX`/`convertPricing` en **producteurs d'indices**, NE PAS supprimer. |
| **anthropic key/oauth, codex** | Déjà 100% API → remonter les capabilities comme seed authoritatif (dédupliquer `MODEL_NOTES`). |

> Traiter openrouter/anthropic/moonshot comme « ids seuls » **régresse** la
> qualité (models.dev dit M3=512k vs 1M réel ; openrouter a 341 modèles plus frais).

### Surprises
- **Le gating image n'existe PAS encore** (`agent-engine.ts:~2722` pousse l'image
  sur `mimeType.startsWith('image/')`, sans lire `supportsImageInput`) → c'est une
  **feature neuve**, pas un rebranchement. `supportsPdfInput` n'existe **nulle
  part**. Défaut prudent : `undefined ≠ false` (**fail-open**) pour ne pas couper
  un modèle réellement multimodal.
- **Proto-registre déjà là** : `model-info-cache.ts` + cron `modelInfoRefreshCron`
  (`config.ts:239`, défaut 6h) → réutilisable pour le resync models.dev→DB.
- **Deux chemins `listModels`** : `resolve.ts` (direct) vs `providers/index.ts:303-389`
  (wrapper, **lossy** : drop thinking/pricing/maxTools) → les deux doivent
  converger sur le registre.
- **Collision de nom UI** : un onglet `models` existe déjà (sélection des défauts)
  → la nouvelle vue prend un id distinct (`modelRegistry`).
- `GET /api/providers/:id/voices` (voix TTS) **n'est PAS** dans le registre →
  ne pas le supprimer en même temps que `/:id/models`.
- `llm_usage` est par `model_id` sans `provider_id` stable → coût historique
  parfois `null` (dégradation propre).

## 13. Plan de migration affiné (feature-flag, SEAM-first, réversible)

Flag **`HIVEKEEP_MODEL_REGISTRY`** (off par défaut). Off → `resolveModelMetadata`
= pass-through (modèle du provider tel quel) → **comportement actuel strictement
préservé**. Chaque étape est mergeable + réversible (flag off / revert du commit).

- **Phase 0 — Fondations (zéro retrait, zéro régression)** : snapshot models.dev
  embarqué + script de build ; schéma `models` + Drizzle + `resolveModelMetadata`
  (matching §6 + priorité §7, no-match `plugin:*`) ; ajouter `supportsPdfInput`.
  *Le snapshot doit exister AVANT de retirer le 1er `inferX` (sinon retour au 128k).*
- **Phase 1 — Brancher les lectures (derrière le flag, pass-through si off)** :
  enrichir au SEAM `resolve.ts` (les 3 chemins, dont `pickAnyLLMModel`) ; repointer
  `model-info-cache`/`setModelInfoLookup` sur le registre ; le cron 6h devient
  resync+réconciliation d'ids (§6, garder le skip plugin-orphan) ; réconciliation
  à l'activation provider. **Vérifier flag-on == flag-off.**
- **Phase 2 — Consommateurs neufs (additifs)** : endpoint `GET /api/models` + vue
  Models (Réglages, id `modelRegistry`) + remap/manuel/resync + SSE ; gating
  upload image/PDF (fail-open) ; dashboard coût (`null` si pas de prix).
- **Phase 3 — Retrait des heuristiques, 1 provider à la fois** : deepseek+minimax
  (ids seuls) → xai+gemini (garder les indices API) → moonshot → openrouter
  (indices, pas suppression) → anthropic/codex (déjà API). Transport intact.
  Flag-off = revert instantané.
- **Phase 4 — Nettoyage** : supprimer `ProviderModelsModal` + `GET
  /api/providers/:id/models` (**garder** `/:id/voices`) ; repointer
  `/api/providers/models`, génération/validation de config Agent ; nettoyer le
  mapping lossy `providers/index.ts:316-323`.
- **Peut attendre** : modèles image (génération/avatars) ; `supportsPromptCaching`
  & `supportsParallelTools` (**aucun consommateur serveur** — migration gratuite).

---

**Synthèse :** registre en base = source de vérité, **seedé par models.dev +
éditable par l'admin** (override par-champ), **snapshot embarqué + cron resync**,
vue dans les Réglages. **On garde le contrat SDK** (champs optionnels → plugins
intacts), on **branche les SEAMs avant de retirer les heuristiques**, derrière un
**feature-flag**, provider par provider. Débloque prix, contexte fiable, gating
image/PDF.
