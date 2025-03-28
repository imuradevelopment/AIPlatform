-- Vaultに秘密情報を保存
SELECT vault.create_secret('', 'project_url');
SELECT vault.create_secret('', 'anon_key');

-- pg_cronとpg_net拡張機能が有効になっていることを確認
-- ※これらの拡張機能はSupabaseのプロジェクト設定から有効化する必要があります
-- SET pg_extension_available.pg_cron = 'true';
-- CREATE EXTENSION IF NOT EXISTS pg_cron;
-- CREATE EXTENSION IF NOT EXISTS pg_net; 