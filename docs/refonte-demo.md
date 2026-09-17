# Démonstration de la refonte

La démonstration utilise une base SQLite temporaire, deux comptes synthétiques et un fournisseur OpenAI simulé sur la machine. Elle ne contient aucune donnée de l'installation habituelle et ne consomme aucun crédit LLM.

Le sélecteur sous la saisie d'une conversation affiche le nom du modèle et propose **Démo A (simulé)** et **Démo B (simulé)** pour essayer le changement de modèle. Ce sont deux réponses simulées, pas des modèles d'IA réels ni des espaces de travail. Dans l'installation habituelle, ce sélecteur affiche les modèles activés de ses fournisseurs configurés. L'ancien nom `workspace-demo` désignait le faux modèle et pouvait prêter à confusion.

Sur `marldev`, l'aperçu privé est accessible à **http://marldev.tail710c78.ts.net:4195**. Connexion administrateur : `admin@demo.test`, membre : `member@demo.test`. Mot de passe des deux comptes : `DemoOnly123!`.

Le service utilisateur `hivekeep-refonte-preview` sert le build de `/tmp/hivekeep-refonte-final`. Un redémarrage recrée les données de démonstration ; l'ancien dossier temporaire reste disponible pour diagnostic. Le chemin figure dans `journalctl --user -u hivekeep-refonte-preview`.

L'aperçu déjà ouvert utilise temporairement le service utilisateur `hivekeep-demo-models` (boucle locale, port 4197) pour proposer les deux modèles sans réinitialiser ses conversations. Les nouvelles démonstrations démarrent directement ce catalogue depuis leur fixture.

## Reproduire les vérifications

```sh
bun install --frozen-lockfile
bun run typecheck
bun run test
bun run build
bun run test:e2e
bun run test:e2e:experience
bun run test:e2e:product
bun run test:e2e:provider
```

Les scripts créent et arrêtent leurs propres serveurs et répertoires temporaires. Playwright doit disposer de Chromium (`bunx playwright install chromium`). Les scripts activent explicitement le sandbox Chromium ; sur Ubuntu avec restriction des espaces de noms utilisateur, le binaire doit être couvert par le profil AppArmor adapté, comme sur `marldev`. Aucun navigateur graphique n'est nécessaire sur le serveur distant. Les rapports et captures des parcours sont écrits sous `/tmp/hivekeep-workspace-e2e` et `/tmp/hivekeep-product-e2e` par défaut.

Dans le chat de démonstration, `[demo:slow]` ralentit la réponse, `[demo:error]` provoque une erreur fournisseur et `[demo:tool]` demande la lecture de `synthese.md` si l'Agent possède la capacité `read_file`. Les réponses sont déterministes ; elles ne représentent pas la qualité d'un vrai modèle.

## Démarrer une autre démonstration privée sur cette machine

Après le build, dans un terminal persistant :

```sh
HIVEKEEP_DEMO_PUBLIC_URL=http://marldev.tail710c78.ts.net:4195 bun run demo
```

Le port 4195 doit être libre. L'application écoute sur l'interface de boucle locale ; l'accès distant passe par Tailscale :

```sh
sudo tailscale serve --bg --yes --http=4195 4195
curl -fsS -o /dev/null -w '%{http_code}\n' http://marldev.tail710c78.ts.net:4195
```

## Arrêter l'aperçu actuel

```sh
systemctl --user stop hivekeep-refonte-preview
systemctl --user stop hivekeep-demo-models
sudo tailscale serve --http=4195 off
```

Ces commandes concernent uniquement la démonstration. Les migrations, sauvegardes et changements d'instance réelle suivent les précautions du [bilan](refonte-bilan-2026-09.md) et du [guide de sauvegarde](backup-and-rollback.md).
