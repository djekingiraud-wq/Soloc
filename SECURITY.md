# Politique de sécurité

## Signaler une vulnérabilité
Ne créez **pas** de ticket public. Écrivez à **REMPLACER-PAR-L-ADRESSE-SECURITE@votre-domaine** (ou utilisez « Report a vulnerability » dans l'onglet Security du dépôt si activé) en décrivant le problème et les étapes pour le reproduire.

## Ce qu'il ne faut jamais publier
Fichiers `.env*`, clés Stripe/Resend, sauvegardes de base, journaux contenant des données clients. Si un secret est publié par erreur : le **révoquer immédiatement** (le retirer de l'historique git ne suffit pas), puis voir `docs/ROLLBACK.md`.
