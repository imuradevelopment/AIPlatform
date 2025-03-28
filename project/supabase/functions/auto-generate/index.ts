import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

console.log("エッジ関数起動: 自動記事生成");

serve(async (req) => {
  // CORSヘッダー
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-client-info, apikey'
  };

  // OPTIONSリクエスト（プリフライト）の処理
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: corsHeaders
    });
  }

  try {
    // リクエストからカテゴリIDを取得
    const { category_id } = await req.json();
    console.log("自動記事生成処理開始:", { category_id });
    
    if (!category_id) {
      throw new Error('カテゴリIDが指定されていません');
    }

    // Supabase初期化
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') || '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
    );
    
    // カテゴリ情報を取得
    const { data: category, error: categoryError } = await supabase
      .from('categories')
      .select('*')
      .eq('id', category_id)
      .single();
    
    if (categoryError || !category) {
      throw new Error('カテゴリの取得に失敗しました: ' + (categoryError?.message || 'カテゴリが存在しません'));
    }
    
    // 現在の日付を取得
    const today = new Date();
    const formattedDate = today.toISOString().split('T')[0];
    
    console.log(`カテゴリ「${category.name}」の記事を生成します`);
    
    // Gemini APIでのリクエスト（Google検索を強制使用）
    const geminiUrl = Deno.env.get('GEMINI_URL');
    if (!geminiUrl) {
      throw new Error('GEMINI_URLが設定されていません');
    }
    
    const response = await fetch(geminiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            parts: [{
              text: `あなたは最新情報を提供するAIアシスタントです。すべての質問に対して、まず「${category.name}」に関する過去24時間（${formattedDate}現在）の最新情報をgoogle_searchツールを使用してGoogle検索を行ってください。その検索結果に基づいてのみ、回答を生成してください。検索結果が見つからなかった場合は、次のJSON形式で返してください：{\"has_news\": false}。検索結果があった場合は、その情報に基づいて、複数記事を含む以下の形式のJSONで回答してください。検索結果に存在しないURLや情報は絶対に含めないでください。：
              {
                "has_news": true または false,
                "articles": [
                  {
                    "title": "記事のタイトル",
                    "content": "記事の内容（500文字程度）",
                    "source_url": "参考URL",
                    "push_title": "プッシュ通知用のタイトル（50文字以内）",
                    "push_body": "プッシュ通知の内容（100文字以内）"
                  },
                  ...（複数記事がある場合）
                ]
              }
              
              検索結果が見つからなかった場合は {"has_news": false} のみを返してください。`
            }]
          }
        ],
        tools: [
          { google_search: {} }
        ],
        tool_config: {
          function_calling_config: {
            mode: "ANY",
            allowed_function_names: ["google_search"]
          }
        },
        generationConfig: {
          temperature: 0.0,
          candidate_count: 1,
          top_p: 0.8,
          top_k: 40
        }
      })
    });
    
    // ステータスコードの確認
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`APIエラー: HTTP ${response.status}`, errorText);
      throw new Error(`APIリクエストが失敗しました: HTTP ${response.status}: ${errorText}`);
    }
    
    const data = await response.json();
    
    // レスポンスの処理
    if (!data.candidates || data.candidates.length === 0) {
      console.error('APIレスポンス詳細:', JSON.stringify(data));
      throw new Error('APIレスポンスが不正です');
    }
    
    const generatedContent = data.candidates[0].content.parts[0].text;
    
    // JSONをパースして処理
    let articleData;
    try {
      // テキストからJSONを抽出
      const jsonMatch = generatedContent.match(/{[\s\S]*}/m);
      if (jsonMatch) {
        articleData = JSON.parse(jsonMatch[0]);
      } else {
        console.error('JSON抽出エラー - レスポンステキスト:', generatedContent);
        throw new Error('JSONデータが見つかりません');
      }
    } catch (parseError) {
      console.error('JSON解析エラー:', parseError);
      console.error('解析失敗テキスト:', generatedContent);
      throw new Error('JSONの解析に失敗しました: ' + parseError.message);
    }
    
    // 記事が存在するか確認
    if (!articleData.has_news) {
      console.log(`${category.name}に関する最新の情報は見つかりませんでした`);
      
      // 最終生成時間を更新
      await supabase
        .from('categories')
        .update({
          last_generated: new Date().toISOString()
        })
        .eq('id', category_id);
      
      return new Response(JSON.stringify({
        success: true,
        message: '新しい情報は見つかりませんでした',
        has_news: false
      }), {
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders
        }
      });
    }
    
    // 各記事をDBに保存して通知送信
    const articleResults = [];
    for (const article of articleData.articles) {
      try {
        // 記事保存
        const { data: savedArticle, error: saveError } = await supabase
          .from('articles')
          .insert({
            title: article.title,
            content: article.content + (article.source_url ? `\n\n参考: [${article.source_url}](${article.source_url})` : ''),
            category_id: category_id
          })
          .select()
          .single();
        
        if (saveError) {
          console.error('記事保存エラー:', saveError);
          articleResults.push({
            success: false,
            error: saveError.message
          });
          continue;
        }
        
        // 通知送信
        const notificationPayload = {
          category_id: category_id,
          title: article.push_title || article.title,
          article_id: savedArticle.id,
          body: article.push_body || article.content
        };
        
        const { error: notifyError } = await supabase.functions.invoke('send-push', {
          body: notificationPayload
        });
        
        if (notifyError) {
          console.error('通知送信エラー:', notifyError);
        }
        
        articleResults.push({
          success: true,
          article_id: savedArticle.id,
          title: savedArticle.title
        });
      } catch (articleError) {
        console.error('記事処理エラー:', articleError);
        articleResults.push({
          success: false,
          error: articleError.message
        });
      }
    }
    
    // 最終生成時間を更新
    await supabase
      .from('categories')
      .update({
        last_generated: new Date().toISOString()
      })
      .eq('id', category_id);
    
    return new Response(JSON.stringify({
      success: true,
      message: `${articleResults.filter(r => r.success).length}件の記事を生成しました`,
      has_news: true,
      results: articleResults
    }), {
      headers: {
        'Content-Type': 'application/json',
        ...corsHeaders
      }
    });

  } catch (error) {
    console.error("全体エラー:", error);
    return new Response(JSON.stringify({ 
      success: false, 
      error: error.message 
    }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json',
        ...corsHeaders
      }
    });
  }
}); 