# Sherpa — Onboarding conversationnel & Kin configurateur

> **Statut** : spécification (non implémentée). Source de vérité pour la feature. Voir aussi `idea.md` (onboarding actuel), `prompt-system.md` (blocs du prompt), `api.md` / `sse.md` (contrats), `schema.md` (DB).
>
> **But** : rendre KinBot installable par n'importe qui d'un peu débrouillard. On remplace le wizard de configuration par une **conversation** avec un Kin configurateur nommé **Sherpa**, ouvert dans une modale au premier lancement. Sherpa configure la plateforme (providers, mémoire, génération d'images, channels, premier Kin) via du chat, en expliquant chaque notion. Il reste ensuite à demeure comme référent de configuration.

---

## 1. Principes directeurs (décidés)

1. **Nom** : `Sherpa` (anglais, invariant — aucune variation selon la langue de l'utilisateur).
2. **Bootstrap incompressible** : Sherpa ne peut pas parler sans LLM valide. L'onboarding garde donc **un minimum de pré-chat formulaire** : compte + langue, puis **une clé LLM native**. Tout le reste passe par le chat.
3. **Thread unique** : la conversation de la modale **EST le thread principal** de Sherpa (`sessionId = NULL`). La modale n'est qu'un `ChatPanel` *distraction-less*. Après fermeture/skip, on retrouve Sherpa et tout l'historique dans la liste des Kins.
4. **Toolbox permanente** : Sherpa possède une toolbox builtin `configurator` (la même en modale et en plein écran). Pas de restriction « par vue » — le toolset est résolu par Kin.
5. **Marqueur** : nouvelle colonne `kins.kind` (`'regular'` | `'configurator'`). Elle pilote : le bloc de prompt spécial, l'assignation de toolbox, l'exclusion des décomptes d'onboarding.
6. **Secrets centralisés dans le vault** : tout point de saisie de secret **référence** une entrée `vault_secrets` (`$vault:<key>`), jamais une copie inline. Rotation de clé = update du vault, point.
7. **Saisie sécurisée** : le secret va **UI → serveur → vault** ; le LLM ne voit jamais que des références non sensibles.
8. **Admin-only** : l'onboarding (et le seed de Sherpa) n'existe que pour le **premier admin**. Les autres utilisateurs arrivent dans l'état courant et voient Sherpa + la conversation de l'admin dans la liste.
9. **Pas de re-trigger** : l'onboarding est « techniquement complet » dès que compte + 1er LLM + Sherpa seedé existent. Le reste, c'est du dialogue.
10. **Sherpa est aussi informateur** : il explique progressivement les capacités de KinBot (création d'outils à la demande, mini-apps, projets). Pédagogue, transparent, arrangeant, **une question à la fois**.

---

## 2. La contrainte de bootstrap

Le Kin configurateur a besoin d'un provider LLM valide pour produire ne serait-ce que sa première réplique. Conséquence ferme : **l'onboarding ne peut pas être 100 % conversationnel.** Il y a toujours, avant le chat :

- la **création du compte** (Better Auth) + la **langue** (le bloc `[7]` du prompt système lit `user_profiles.language` ; sans elle Sherpa démarrerait en anglais) ;
- la **connexion d'un provider LLM natif** (un seul geste manuel : une clé).

> Note pédagogique à afficher sur l'écran de connexion : *« Pour donner vie à ton assistant il faut un provider natif. Plus tard tu pourras installer des plugins qui ajoutent d'autres providers et modèles, mais le configurateur a besoin d'un provider natif pour démarrer. »*

Le catalogue `PROVIDER_META` (`src/shared/provider-metadata.ts`) fournit déjà, par type, l'URL de génération de clé — on s'en sert pour guider l'écran.

---

## 3. Flow d'onboarding (admin, premier lancement)

### 3.1 Écran « Compte »
Champs : email, mot de passe, prénom, nom, pseudo, **langue**. (On **supprime** l'étape *Préférences* séparée : thème/palette deviennent réglables plus tard dans les Settings, ou proposés par Sherpa.) Crée le `user`/`user_profiles` (role `admin`) et le contact auto, comme aujourd'hui (`routes/onboarding.ts`).

### 3.2 Écran « Connecte un provider LLM »
Liste **uniquement les types LLM natifs** (depuis `GET /api/providers/types` filtré sur capability `llm`, hors `plugin:`). Pour chaque type : label, lien direct vers la page de clé (`PROVIDER_META.apiKeyUrl`), champ(s) issus du `configSchema`, bouton **Tester**. Au succès : provider créé (secret vaultifié, cf. §6) + défini comme `default_llm_provider_id`.

### 3.3 Seed de Sherpa (serveur)
Endpoint `POST /api/onboarding/configurator` `{ providerId }` (exempté d'auth comme le reste de `/api/onboarding/*`, mais réservé au cas « admin existe, aucun configurateur »). Idempotent. Il :
1. résout un **modèle** pour Sherpa (cf. §4.2) ;
2. crée le Kin `kind='configurator'`, `createdBy = adminUserId`, `toolboxIds = ['configurator']`, `name='Sherpa'`, rôle/character/expertise prédéfinis ;
3. **copie l'avatar bundlé** (cf. §4.1) vers `data/uploads/kins/<id>/avatar.png`, set `avatarPath` ;
4. **enfile le message d'amorce** (cf. §4.5).

### 3.4 Ouverture de la modale
Nouveau composant `OnboardingChatModal` = `Dialog` enveloppant `ChatPanel` pointé sur le thread principal de Sherpa, chrome masqué (pas de sidebar, pas de model-picker/éditeur). Auto-ouverte au premier chargement tant que : configurateur = seul Kin **et** flag « modale non rejetée » (cf. §3.5).

### 3.5 Skip & reprise
Fermer la modale ouvre un **warning** : *« Sûr de vouloir arrêter l'onboarding ? Tu pourras reprendre à tout moment en parlant à Sherpa dans ta liste de Kins. »* Confirmé → on pose un flag (`user_profiles.onboarding_modal_dismissed = 1`) pour ne plus auto-ouvrir. L'historique reste intact (thread principal). L'utilisateur reprend en sélectionnant Sherpa dans la liste.

---

## 4. Sherpa, le Kin configurateur

### 4.1 Identité & avatar bundlé
- Avatar fixe livré dans les sources : `src/server/assets/sherpa-avatar.png` (à générer côté projet). **Non généré** (aucun image provider à ce stade) : copié au seed.
- *(Optionnel)* `src/server/assets/default-kin-avatar.png` comme fallback générique pour tout Kin créé sans image provider (aujourd'hui : initiales seulement). Hors périmètre strict.

### 4.2 Résolution du modèle
`resolveConfiguratorModel(providerId)` : tente un **modèle recommandé par type** (nouvelle map `RECOMMENDED_CONFIGURATOR_MODELS` dans `src/shared/constants.ts`, ex. `anthropic`→un Sonnet, `openai`→un gpt récent, `gemini`→un flash/pro, `openrouter`/`xai`→défaut raisonnable) ; si indisponible dans `listModels`, **fallback sur le premier modèle listé** du provider. Évite de seeder Sherpa avec un `model` invalide (sinon il ne répond jamais).
> `thinkingConfig` modeste (onboarding fluide/pragmatique, pas de surcoût de raisonnement).

### 4.3 Toolbox `configurator`
Nouveau builtin dans `src/server/services/toolboxes.ts` (s'ajoute à `CORE_TOOLS`). Outils :
```
describe_provider_config, list_provider_types, list_providers, list_models,
request_provider_setup, enable_provider_capability, set_default_provider, test_provider,
request_channel_setup, list_channels, test_channel,
create_kin, update_kin, set_avatar_style,
get_global_prompt, set_global_prompt,
generate_image, list_image_models, describe_image_model,
create_contact, set_contact_note, get_contact,
memorize, recall,
prompt_secret, prompt_human,
web_search, browse_url
```
> `generate_image` est inclus volontairement : une fois l'image provider branché, Sherpa peut **générer un avatar d'exemple** pour se mettre d'accord sur le style de façon empirique (cf. §9).
> `create_kin`/`update_kin`/channel admin sont aujourd'hui `defaultDisabled` et `HARD_EXCLUDED_FROM_SUBKIN` — ce sont des tools « main ». Sherpa est un Kin **main**, donc ils s'appliquent dès qu'ils sont dans sa toolbox. La même toolbox sert en modale et en liste (réponse à la contrainte « toolset restreint » sans infra par-vue).

### 4.4 Bloc système `[Configurator mission]`
Injecté **uniquement si `kin.kind === 'configurator'`** (et `!isSubKin`), dans le segment **STABLE** de `buildSystemPrompt()` (`prompt-builder.ts`), après *Platform directives* et avant *Contacts*.

> ⚠️ `PromptParams.kin` est aujourd'hui une projection (`name, slug, role, character, expertise`) **sans `kind`**. Ajouter `kinKind?: string` à `PromptParams` (ou enrichir la projection) et le câbler dans l'appelant (`kin-engine.ts`).

Contenu (rédaction finale en anglais, ton pédagogue) — **data-driven** : à chaque tour, le bloc inclut un **état courant de la plateforme** (lu en base) pour rester *reprenable* :
- providers configurés + capacités couvertes (llm/embedding/image/search/tts/stt) et défauts définis ;
- channels configurés ;
- nombre de Kins « réels » (hors configurateur) ;
- style d'avatar courant.

Et des **directives** :
- mission = guider la config par étapes, expliquer le *pourquoi* de chaque brique (« j'ai besoin d'un modèle d'embedding pour indexer tes souvenirs ») ;
- **une question à la fois** (contrainte `prompt_human`/`prompt_secret` : 1 appel/tour) ;
- pour les secrets, **toujours** passer par `request_provider_setup` / `request_channel_setup` / `prompt_secret` (jamais demander de coller une clé en clair dans le chat) ;
- **réutiliser** un provider existant quand une clé couvre plusieurs capacités (ex. OpenAI → proposer d'activer l'embedding via `enable_provider_capability`, sans redemander de secret) ;
- proposer **tôt** un provider de **recherche** (utile pour retrouver les pages de création de clés) ;
- demander des **règles de conduite globales** (« as-tu des règles, ou des choses que tu veux que *tous* tes Kins connaissent / respectent ? ») et les écrire dans le **global prompt** (`get_global_prompt` puis `set_global_prompt` en lecture-modification-écriture pour ne pas écraser l'existant) ;
- s'appuyer sur sa **base de connaissances** (cf. §4.6) pour **ne jamais botter en touche** : il connaît les fonctionnalités, l'architecture et le méta-projet (créateur, repo officiel, où trouver de l'aide) ;
- **posture proactive (vendeur, pas insistant)** : au fil de la conversation et **en fin d'onboarding**, proposer les features pertinentes selon le profil de l'utilisateur et l'état courant (« vu que tu fais X, les *crons* / *mini-apps* / *projets* pourraient t'aider à… ») — proposer, expliquer le bénéfice, ne pas forcer ;
- **informer** progressivement : capacité à créer des outils à la demande, des mini-apps, la notion de projets (travail long terme), les crons, les sous-Kins/tasks, la mémoire, le vault, les channels.

Ordre conversationnel **indicatif** (pas un script rigide ; l'état courant prime) : se présenter → fiche utilisateur (contact + notes) → règles de conduite globales (global prompt) → recherche web → embedding (mémoire) → génération d'images + style d'avatar → channels → premier vrai Kin → informer (outils/mini-apps/projets).

> **Global prompt** : le texte injecté à *tous* les Kins comme bloc `[3.5] Platform directives` (`app_settings.global_prompt`). Le service (`getGlobalPrompt`/`setGlobalPrompt`), la route REST (`routes/settings.ts`) et l'UI (`GeneralSettings.tsx`) existent déjà ; **seul le tool natif manque**.

### 4.5 Message d'amorce (kickoff)
Au seed, `enqueueMessage({ kinId, sourceType:'system', messageType:'kin_greeting', content:'[Onboarding started — greet the user and begin.]', priority: kinPriority })`. Le worker déclenche un tour LLM ; Sherpa produit le message de bienvenue **sans bulle utilisateur visible** (le client ne rend pas les `sourceType:'system'` comme bulle).
> À **vérifier** au build : rendu côté client des messages `sourceType:'system'` (cf. mémoire `sse-user-message-multidevice` — ne pas casser le broadcast des messages user).

### 4.6 Base de connaissances de Sherpa
Pour que Sherpa réponde avec autorité (et **ne botte jamais en touche**), il faut une connaissance **fiable et toujours en contexte** — pas une recherche mémoire faillible.

- **Document bundlé** `src/server/assets/sherpa-knowledge.md`, **chargé au démarrage** (lecture cachée) et injecté dans le **segment STABLE** du prompt de Sherpa (bloc `[Configurator knowledge]`, juste après `[Configurator mission]`). Stable ⇒ amorti par le cache de prompt ; **uniquement** pour `kind==='configurator'`, donc aucun impact sur les autres Kins.
- **Contenu à rédiger** (gros prompt — tâche 27.5.6) :
  - **Catalogue des fonctionnalités** avec, pour chacune, *à quoi ça sert / quand le proposer* : Kins & sous-Kins (tasks `await`/`async`), crons, mémoire (extraction auto + outils), vault/secrets, channels (Discord/Telegram…), mini-apps, projets & tickets, custom tools, MCP servers, providers & capacités (llm/embedding/image/search/tts/stt), recherche web, génération d'images, TTS/STT, compacting, communication inter-Kins, palettes/design.
  - **Architecture globale** (vulgarisée) : process unique, SQLite unique, conteneur unique, queue FIFO par Kin, SSE global, plugins.
  - **Méta-projet** (faits figés) : produit **KinBot** (*« AI agents that actually remember you »*) ; créateur **marlburrow** (GitHub [@MarlBurroW](https://github.com/MarlBurroW)) ; repo `https://github.com/MarlBurroW/kinbot` ; site `https://marlburrow.github.io/kinbot/` ; docs `https://marlburrow.github.io/kinbot/docs/` ; licence **AGPL-3.0-only** ; aide via GitHub **Issues**/**Discussions** (pas de Discord) ; **open source, self-hosted, pas de SaaS prévu**.
  - **Limites & garde-fous** : ce que Sherpa peut/doit ne pas faire (ne jamais demander un secret en clair, config globale réservée à l'admin, etc.).
- **Posture proactive — quoi vendre, dans quel ordre.** Il n'y a pas *une* feature reine universelle ; la valeur est **segmentée selon le profil** (lu dans la fiche). Sherpa mène avec le **hero** puis amplifie selon ce que fait l'utilisateur :
  - **Hero (toujours)** : *une équipe d'IA qui se souvient vraiment de toi et s'améliore avec le temps* — mémoire persistante + Kins spécialisés par domaine/tâche. C'est le cœur, déjà amorcé par la fiche/les notes pendant l'onboarding.
  - **Amplificateurs (selon profil, par valeur perçue décroissante pour le grand public)** :
    1. **Channels (Discord/Telegram)** — parler à ses Kins depuis le téléphone, partout. Hook fort, immédiat (« tu peux carrément texter ton assistant »).
    2. **Plateforme auto-améliorante : custom tools + mini-apps** — KinBot se dote d'outils/d'apps pour tes besoins récurrents. Gros effet « waouh » mais abstrait → **pitch contextuel** (« tu me redemandes souvent X, je te crée une mini-app pour ça ? »), pas en façade.
    3. **Automatisation : crons + sous-Kins/tasks** — déléguer et planifier. À proposer quand un besoin récurrent/planifié apparaît.
    4. **Projets & tickets** — gros chantiers long terme. À proposer **seulement** si l'utilisateur signale un projet ; sinon overkill et déroutant.
  - **Règle** : matcher au profil, jamais de pitch générique ; proposer + expliquer le bénéfice + lien doc, ne pas forcer.
- **Ton par défaut** : chaleureux et accessible (tutoiement en FR), proche du ton du site (« AI agents that actually remember you ») — ajustable plus tard.
- **Source canonique** : distiller depuis `idea.md`, `CLAUDE.md`, `schema.md`… Le doc est une **distillation orientée Sherpa**, à **maintenir** quand KinBot évolue (note de maintenance en tête du fichier).
- *(Évolution future)* ce même doc pourrait alimenter une **knowledge base partagée** pour que tout Kin ait une awareness minimale de KinBot — hors périmètre.

---

## 5. Multi-utilisateurs / invités

- **Aucun onboarding** pour les non-admins : ils atterrissent dans l'état courant de la plateforme.
- Sherpa et son thread (initié par l'admin) sont visibles dans la liste partagée.
- Le multi-user reste léger : UI partagée, les utilisateurs sont des **personnes distinctes** aux yeux des Kins (contacts), et peuvent ouvrir des **quick sessions** privées. Rien de spécifique à Sherpa ici.
- Les outils de **config globale** (providers/channels/défauts) doivent rester réservés à l'admin → garde-fou serveur sur ces tools (vérifier le rôle de l'utilisateur courant du tour).

---

## 6. Secrets centralisés dans le vault (refactor)

### 6.1 Principe
La valeur brute d'un secret vit **uniquement** dans `vault_secrets`. La config d'un provider stocke une **référence** pour chaque champ secret :
```jsonc
// providers.configEncrypted (toujours chiffré), après vaultification :
{ "baseUrl": "https://api.openai.com/v1", "apiKey": "$vault:provider_openai_<id>_apiKey" }
```
Avantages : source unique de vérité, **rotation triviale** (un seul `update_secret`), cohérence avec les channels.

### 6.2 Schéma de config par type — **déjà existant**
Chaque provider déclare `configSchema: readonly ConfigField[]` (`packages/sdk/src/index.ts`), `ConfigField.type ∈ {secret,path,url,text}`. Les champs `secret` sont exactement ceux à vaultifier. Accessible via `readConfigSchema(type)` (`routes/providers.ts`) et `GET /api/providers/types`. Helper à ajouter : `getSecretFieldKeys(type): string[]`.

### 6.3 Helpers partagés
- **Écriture** `vaultifyProviderConfig(type, providerId, rawConfig)` → pour chaque champ `secret` non vide : `createSecret('provider_<type>_<id>_<field>', value)` puis remplace la valeur par `"$vault:<key>"`. Renvoie la config à chiffrer.
- **Lecture** `hydrateProviderConfig(parsedConfig)` → pour toute valeur `"$vault:<key>"`, substitue `getSecretValue(key)`.
- **Suppression** : au delete d'un provider, scanner les refs `$vault:` et `deleteSecret`.

### 6.4 Point d'hydratation & sites concernés
Le LLM passe par `readProviderConfig()` (`llm/core/resolve.ts:38`), **mais ~27 sites** déchiffrent la config indépendamment (`embeddings.ts`, `search-resolver.ts`, `tts-resolver.ts`, `stt-resolver.ts`, `image-generation.ts`, `routes/providers.ts`, `tools/{provider,image,voice}-tools.ts`…). Plan : **factoriser** un unique `loadProviderConfig(row): Promise<ProviderConfig>` (= `decrypt` + `JSON.parse` + `hydrateProviderConfig`) et **router les 27 sites** dessus. Liste exhaustive des sites à migrer : voir la Phase 27 (tâche 27.2). Refactor mécanique mais à faire en entier (sinon un site oublié casse l'auth).
> Hors périmètre : `email-accounts.ts`, `calendar-accounts.ts`, `contacts-accounts.ts`, `connected-accounts.ts` (OAuth) suivent le même pattern inline mais restent inchangés pour limiter le blast radius (évolution future possible).

### 6.5 Rotation de clé
Changer une clé = `update_secret('provider_<type>_<id>_<field>', newValue)` (tool ou UI vault). Aucune réécriture de provider, prise en compte immédiate à la prochaine hydratation.

### 6.6 Migration boot idempotente
Nouveau `src/server/services/migrate-provider-vaulting.ts`, appelé dans `index.ts` après les migrations Drizzle (pattern existant : `migrateModelProviders`, `backfillProviderSlugs`). Pour chaque provider : si la config contient déjà une ref `$vault:` → skip ; sinon déchiffrer, vaultifier les champs `secret` (via `configSchema`), réécrire/recrypter. Idempotent.

### 6.7 Channels
Déjà vault-backed (`channel_<platform>_<id>_<field>`). On **réutilise** le pattern ; optionnellement on factorise channels + providers sur les mêmes helpers (non bloquant — les channels fonctionnent déjà).

---

## 7. Saisie sécurisée (secure input)

### 7.1 Principe
Calqué sur `human-prompts.ts` : un tool **suspend** le tour, émet un event SSE qui ouvre une **modale de saisie**, l'utilisateur répond via une route, le secret est **écrit dans le vault** (jamais renvoyé au LLM), puis le tour **reprend** avec une confirmation **non sensible**.

### 7.2 Tools
- `request_provider_setup({ type, name, families?, config? })` — `config` = champs **non secrets** uniquement. Le serveur déduit les champs secrets via `configSchema`, ouvre la modale, et **au submit crée + teste** le provider (secrets → vault, config → refs). Retour LLM : `{ status:'pending' }` puis (après reprise) `{ valid, providerId, capabilities }`.
- `request_channel_setup({ platform, name, config? })` — idem pour Discord/Telegram (créa + activation + `test_channel`).
- `prompt_secret({ key, label, description? })` — secret libre : écrit `vault_secrets[key]`, retour `{ stored:true, key }`.
- `describe_provider_config(type)` / `list_provider_types` (read) — pour que Sherpa sache **quels champs** et **lequel est secret** avant d'appeler `request_provider_setup`.

### 7.3 Table `secret_prompts`
Nouvelle table dédiée (isolée de `human_prompts`, jamais loggée) :
`id, kin_id, task_id?, session_id?, purpose ('provider'|'channel'|'vault'), spec (JSON: type/name/families/non-secret config/secret field keys/platform…), status ('pending'|'answered'|'cancelled'), result_ref (JSON: providerId/channelId/vault keys), created_at, responded_at`.
> **Aucune valeur de secret n'est stockée ici** — au submit, les valeurs vont directement au vault.

### 7.4 Events SSE
- `prompt:secret-request` `{ promptId, purpose, fields:[{ key, label, secret, placeholder, keyUrl? }] }`
- `prompt:secret-resolved` `{ promptId, ok, summary }`
(à déclarer dans `src/server/sse/types.ts` + `sse.md` + `api.md`.)

### 7.5 Route de réponse & reprise
`POST /api/secret-prompts/:id/respond` `{ values: Record<fieldKey,string> }` :
1. valider (non vide) ; **ne jamais logger `values`** ;
2. selon `purpose` : créer les `vault_secrets`, puis créer+tester le provider/channel (ou juste vault) ;
3. claim atomique du tour suspendu (pattern human-prompts) + injecter un message système **non sensible** (`[Provider OpenAI configured — valid: true]`) ;
4. `runOrQueueResumedTask` / ré-enfilement pour la conversation principale ;
5. émettre `prompt:secret-resolved`.
> Génération de l'id provider **avant** la création des clés (la clé vault contient l'id) : générer l'uuid → créer les secrets → insérer la ligne provider.

### 7.6 Analyse de fuite
| Risque | Mitigation |
|---|---|
| Secret dans le prompt LLM | Le LLM ne reçoit que `{valid, providerId}` / une confirmation par clé ; jamais la valeur |
| Secret dans les logs | La route et les services ne loggent que `key`/`promptId`, jamais `values` |
| Secret en clair au repos | `vault_secrets` chiffré AES-256-GCM (transparent) |
| Transport | HTTPS (infra de déploiement) |
| Compacting | La confirmation est non sensible → pas de redaction nécessaire |
| Course multi-device | Claim atomique `status pending→answered` (pattern human-prompts) |

---

## 8. Outils de configuration (catalogue & statut)

| Tool | Statut | Note |
|---|---|---|
| `describe_provider_config`, `list_provider_types` | **À créer** (read) | wrappe `readConfigSchema` / `GET /providers/types` |
| `request_provider_setup` | **À créer** | secure input (§7) |
| `test_provider` | **À créer** | wrappe `testProviderConnection` |
| `enable_provider_capability(providerId, capability)` | **À créer** | PATCH `capabilities[]` (réutilisation de clé) |
| `set_default_provider(capability, providerId)` | **À créer** | écrit `app_settings.default_*` |
| `get_global_prompt`, `set_global_prompt` | **À créer** (tool) | service/route/UI existent déjà (`app-settings.ts`, `settings.ts`, `GeneralSettings.tsx`) ; règles de conduite globales (bloc `[3.5]`). Lecture-modification-écriture pour ne pas écraser |
| `request_channel_setup`, `test_channel` | **À créer** | secure input + adaptateurs |
| `set_avatar_style(style)` | **À créer** | §9 |
| `generate_image`, `list_image_models`, `describe_image_model` | **Existe** | exemples d'avatar pour l'accord empirique (§9) |
| `prompt_secret` | **À créer** | secure input générique |
| `create_kin`, `update_kin` | **Existe** (`defaultDisabled`) | inclure dans la toolbox |
| `create_contact`, `set_contact_note`, `get_contact` | **Existe** | la « fiche » |
| `memorize`, `recall` | **Existe** | préférences |
| `list_providers`, `list_models`, `list_channels` | **Existe** | discovery |
| `web_search`, `browse_url` | **Existe** | trouver les pages de clés |
| `prompt_human` | **Existe** | choix oui/non, sélections (non sensible) |

---

## 9. Personnalisation du prompt d'avatar

- Aujourd'hui : `buildAvatarPrompt()` (`services/image-generation.ts:412`) utilise des constantes **codées en dur** (`AVATAR_EDIT_SYSTEM`, `AVATAR_GENERATE_SYSTEM`).
- Ajout : clé `app_settings.avatar_style_prompt` (texte libre, défaut vide). Injectée comme **directive de style globale** dans les deux modes (`edit`/`generate`). Vide → comportement actuel (baseline Pixar 3D robot conservée).
- Tool `set_avatar_style(style)` (Sherpa) + champ d'édition dans les Settings (UI utilisateur). S'applique aux **futures** générations (pas rétroactif). Sherpa `memorize` aussi la préférence.

**Accord empirique sur le style.** Une fois l'image provider branché, Sherpa ne se contente pas de noter un mot-clé : il propose de **générer un avatar d'exemple** et d'itérer jusqu'à validation. Boucle type :
1. l'utilisateur exprime une direction (« plutôt heroic fantasy » / « cyborg cyberpunk ») ;
2. Sherpa appelle `generate_image` avec un prompt construit à partir de cette direction (+ baseline headshot) et affiche l'exemple dans le chat ;
3. il demande l'avis (`prompt_human` ou question ouverte), ajuste le prompt, régénère si besoin ;
4. une fois validé, `set_avatar_style(style)` fige la directive de style globale + `memorize`.
> Coût : la génération d'exemples consomme des crédits image — Sherpa propose la génération, ne l'impose pas, et limite le nombre d'itérations.

---

## 10. Changements de schéma (DB)

| Table | Changement |
|---|---|
| `kins` | `+ kind TEXT NOT NULL DEFAULT 'regular'` (`'regular'`\|`'configurator'`) |
| `secret_prompts` | **nouvelle** (cf. §7.3) |
| `user_profiles` | `+ onboarding_modal_dismissed INTEGER NOT NULL DEFAULT 0` |
| `app_settings` | nouvelles clés `avatar_style_prompt` (et défauts existants réutilisés) |
| `providers.configEncrypted` | format inchangé, **contenu** migré vers refs `$vault:` (migration §6.6) |

> Migrations Drizzle via `bun run db:generate` + `db:migrate` (pas de `db:push`). La vaultification des providers existants est une **migration applicative au boot** (§6.6), pas une migration SQL.

---

## 11. Events SSE (récap des ajouts)
`prompt:secret-request`, `prompt:secret-resolved` (cf. §7.4). Documenter dans `sse.md` (règles emit↔handle) et `api.md`.

---

## 12. i18n
Namespace `sherpa.*` + clés des écrans d'onboarding et de la modale de secret, dans `en.json` / `fr.json`. Le **persona** de Sherpa (nom, blocs de prompt) reste en anglais ; ses réponses suivent `user_profiles.language` (bloc `[7]`).

---

## 13. Hors périmètre / futur
- Vaultification des comptes OAuth (`email/calendar/contacts/connected-accounts`).
- Fallback avatar générique pour tout Kin sans image provider.
- Onboarding allégé pour invités (actuellement : aucun).
- Refactor channels sur les helpers partagés providers (non bloquant).

---

## 14. Questions ouvertes / décisions
1. ✅ **Résolu** — modèle de seed : **défauts équilibrés** (milieu-de-gamme fiables en tool-use) par type natif, fallback `listModels`. Map `RECOMMENDED_CONFIGURATOR_MODELS` à curater au build (§4.2).
2. *(décision build)* Garde-fou « config globale = admin only » : vérifier le rôle de l'utilisateur **du tour courant** dans les tools providers/channels — placement à trancher à l'implémentation.
3. **Checklist** (non tranché) : proposé = retirer la grosse carte, **garder** les bannières inline aux points d'usage. À confirmer.
4. ✅ **Résolu** — méta-projet figé (§4.6) : KinBot / marlburrow / repo `MarlBurroW/kinbot` / AGPL-3.0-only / open-source self-hosted. Priorité de pitch : hero (mémoire + Kins spécialisés) → channels → tools/mini-apps → automatisation → projets (§4.6).
