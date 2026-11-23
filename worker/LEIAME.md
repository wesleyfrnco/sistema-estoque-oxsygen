# Worker do sistema de estoque

Este é o servidor do sistema (oxsygen-estoque na Cloudflare).

- Qualquer alteração em `worker/` publicada no branch `main` é enviada para a Cloudflare
  automaticamente pelo GitHub Actions (aba Actions do repositório).
- Segredos (`SEGREDO`, `META_CAPI_TOKEN`) ficam só no painel da Cloudflare.
- Backup: todo dia às 03:00 (Fortaleza) o banco é copiado para o bucket R2 `oxsygen-backup`,
  pasta `diario/`. As cópias com mais de 90 dias são apagadas.
- No sistema, em Resumo > Backup, o dono baixa uma cópia na hora ou qualquer cópia diária.
