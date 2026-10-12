# Audit SOLOC — 11 octobre 2026

Périmètre : backend (API, base, permissions, tarification, réservations), site web (parcours, sécurité, responsive), application mobile (code).
Outils : Node 22 (tests), Chromium 141 via Playwright (navigateur), TypeScript (typage partiel du mobile).

## 1. Réussi (exécuté)
| Domaine | Vérification | Résultat |
|---|---|---|
| Permissions | 25 routes × 4 rôles (anonyme, client, employé, admin) = 100 combinaisons | conforme |
| Isolation | un client ne lit ni n'annule la réservation d'un autre (404) ; infos staff absentes côté client | conforme |
| Comptes | compte désactivé : accès coupé immédiatement | conforme |
| Réservations | contenu, contenant, identique, chevauchement partiel, bout à bout, autre véhicule | conforme |
| Concurrence | 300 demandes simultanées aléatoires sur 3 véhicules, 12 clients : aucun chevauchement en base | conforme |
| Tarification | 3 000 cas aléatoires + frontières (24 h, 24 h + 1 ms, 7 jours) ; arrondis TVA/remise comparés à l'arithmétique entière sur 400 000 valeurs | aucune divergence |
| Prix | un montant envoyé par le client est ignoré ; changement de tarif non rétroactif | conforme |
| Entrées hostiles | ~700 requêtes (types inattendus, SQL, HTML, URL mal encodées, JSON invalide) | aucun 500 |
| HTTP | en-têtes, cookie HttpOnly/SameSite, Secure + HSTS en production, pas de stack dans les erreurs | conforme |
| Données | mots de passe hachés (scrypt), jetons de session hachés (SHA-256), aucun secret en dur | conforme |
| Navigateur | 4 largeurs (360, 390, 768, 1280) × 6 pages : aucun débordement horizontal, aucune erreur JavaScript | conforme |
| Parcours client | catalogue, options, validation de formulaire, inscription dans le tunnel, confirmation avec référence, « Mes réservations », annulation, accès admin refusé | conforme |
| Parcours admin/employé | indicateurs écran = API, confirmation met à jour la base ; l'employé ne voit ni chiffre d'affaires ni boutons admin | conforme |
| Clavier | focus visible sur 8/8 éléments testés | conforme |
| Contrastes | 20 couples de couleurs calculés (WCAG) | tous ≥ 4,5:1 après correction |

Totaux : 41 tests backend + client mobile, 8 tests mobile, 55 contrôles navigateur — tous réussis après corrections.

## 2. Échecs constatés, puis corrigés
| # | Gravité | Problème | Correction |
|---|---|---|---|
| 1 | Critique | XSS stocké : un nom de client ou de véhicule contenant du HTML s'exécutait dans le navigateur (dont celui de l'admin) — confirmé dans Chromium | échappement de tout contenu serveur dans l'interface + refus de `<` `>` dans les noms |
| 2 | Élevé | Limite de connexion comptant aussi les succès : un client légitime pouvait être bloqué après 5 connexions ; blocage d'un bureau entier derrière une même IP ; mémoire jamais purgée | seuls les échecs comptent, purge, option `TRUST_PROXY` |
| 3 | Élevé | `PATCH /api/admin/users/:id` avec un corps vide désactivait le compte ; identifiant non numérique accepté | booléen explicite, identifiant validé, 404 si inconnu |
| 4 | Moyen | Erreurs 500 : identifiant non textuel (réservation, incident), URL mal encodée, devis sans paramètres | validation de type, 400 propre |
| 5 | Moyen | Contrôle CSRF contournable en omettant l'en-tête Content-Type | 415 dès qu'un corps est présent |
| 6 | Moyen | Un client pouvait bloquer toute la flotte avec des demandes en attente illimitées | plafond de 3 demandes en attente (`MAX_PENDING_PER_USER`) |
| 7 | Moyen | Encaissement supérieur au montant dû accepté | refus 409 |
| 8 | Moyen | Recherche avec retour avant départ acceptée ; devis au-delà de 60 jours alors que la réservation le refuse | même validation partout |
| 9 | Faible | Connexions non journalisées ; journal limité à 200 lignes sans filtre | `auth.login` / `auth.login_failed`, filtre `action`, pagination |
| 10 | Faible | Accessibilité : 4 contrastes insuffisants (de 2,17:1 à 4,33:1) ; zones tactiles de 19 à 42 px | couleurs corrigées (≥ 4,95:1), cibles de 44 px |
| 11 | Faible | Sessions expirées jamais supprimées | purge à la connexion |

## 3. Ouvert, non corrigé (à décider)
- La CSP autorise les scripts en ligne (l'interface web utilise des `onclick`) : l'échappement est la seule barrière contre le XSS. Durcissement : supprimer les gestionnaires en ligne puis retirer `unsafe-inline`.
- Limiteurs de tentatives en mémoire d'un seul processus (Redis en production multi-instances).
- Pas de réinitialisation de mot de passe, de vérification d'e-mail ni d'authentification à deux facteurs pour l'admin ; l'inscription révèle qu'un e-mail existe (409).
- Jeton mobile valable 7 jours sans renouvellement.
- « Aujourd'hui » calculé en UTC ; durée comptée en tranches de 24 h entamées (10 h → 10 h 30 le lendemain = 2 jours) : règle à valider par SOLOC.
- Saisies par boîtes de dialogue (`prompt`) sur le web admin ; pas de RLS ni de journal d'audit infalsifiable côté base.

## 4. Vérifications impossibles ici
- **PostgreSQL** : schéma, adaptateur, contrainte `EXCLUDE`, `FOR UPDATE`, conversion des types — jamais exécutés. À rejouer : `npm test` avec `DATABASE_URL`, en particulier le test de charge.
- **Application mobile** : les écrans n'ont été ni lancés ni compilés (pas de réseau pour installer Expo). Typage partiel avec bibliothèques simulées (aucune erreur) ; comportement iOS/Android, VoiceOver/TalkBack, trousseau sécurisé, sélecteur de date non vérifiés.
- **Navigateurs** : Chromium seulement (pas Safari/WebKit ni Firefox), appareil tactile émulé ; polices Google non chargées (repli système), donc rendu avec la police de marque non vérifié.
- Lecteur d'écran, audit Lighthouse/axe, test d'intrusion externe, performance en charge réelle, sauvegarde/restauration, conformité RGPD et juridique, `npm audit` des dépendances mobile (réseau).
- Non implémentés donc non auditables : paiement en ligne, e-mails, notifications push, photos, PDF et contrats.

## Rejouer l'audit
```
npm test            # 41 tests (backend + client mobile)
npm run test:mobile # 8 tests
npm run test:browser # 55 contrôles Chromium (Playwright requis)
```
