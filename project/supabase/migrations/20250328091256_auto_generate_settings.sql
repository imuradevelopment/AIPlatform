-- カテゴリテーブルに自動生成設定カラムを追加
ALTER TABLE categories ADD COLUMN auto_generate BOOLEAN DEFAULT FALSE;
ALTER TABLE categories ADD COLUMN generate_interval INTEGER DEFAULT 30; -- 分単位
ALTER TABLE categories ADD COLUMN last_generated TIMESTAMP WITH TIME ZONE;
ALTER TABLE categories ADD COLUMN cron_job_id TEXT;

-- 記事自動生成用RPCを作成
CREATE OR REPLACE FUNCTION update_category_schedule(
  p_category_id UUID,
  p_auto_generate BOOLEAN,
  p_generate_interval INTEGER
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_category RECORD;
  v_job_name TEXT;
  v_cron_expression TEXT;
  v_statement TEXT;
BEGIN
  -- カテゴリ情報を取得
  SELECT * INTO v_category FROM categories WHERE id = p_category_id;
  
  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;
  
  -- 既存のジョブがあれば削除
  IF v_category.cron_job_id IS NOT NULL THEN
    PERFORM cron.unschedule(v_category.cron_job_id);
  END IF;
  
  -- 設定更新
  UPDATE categories SET 
    auto_generate = p_auto_generate,
    generate_interval = p_generate_interval
  WHERE id = p_category_id;
  
  -- 自動生成がオフなら終了
  IF NOT p_auto_generate THEN
    RETURN TRUE;
  END IF;
  
  -- ジョブ名を設定
  v_job_name := 'generate_article_' || p_category_id::text;
  
  -- Cronスケジュール式を生成 (*/30 * * * * = 30分ごと)
  v_cron_expression := '*/' || p_generate_interval::text || ' * * * *';
  
  -- JSONを使用してSQL文を構築
  v_statement := format('
    SELECT net.http_post(
      url:= (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = ''project_url'') || ''/functions/v1/auto-generate'',
      headers:=jsonb_build_object(
        ''Content-Type'', ''application/json'',
        ''Authorization'', ''Bearer '' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = ''anon_key'')
      ),
      body:=jsonb_build_object(''category_id'', %L)
    );
  ', p_category_id::text);
  
  -- 新しいスケジュールを作成
  PERFORM cron.schedule(
    v_job_name,
    v_cron_expression,
    v_statement
  );
  
  -- ジョブIDを保存
  UPDATE categories SET cron_job_id = v_job_name WHERE id = p_category_id;
  
  RETURN TRUE;
END;
$$;