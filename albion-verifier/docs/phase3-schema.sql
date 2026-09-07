-- ===========================================================================
-- Albion Phase 3: Memory & Context — Supabase SQL Schema Extension
--
-- Run these SQL statements in your Supabase SQL Editor.
-- Extends the schema with pgvector-based repository embeddings and semantic search.
-- ===========================================================================

-- 1. Enable the pgvector extension (Supabase built-in)
CREATE EXTENSION IF NOT EXISTS vector;

-- 2. Create the repo_embeddings table
CREATE TABLE IF NOT EXISTS public.repo_embeddings (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  project_path TEXT NOT NULL,
  file_path TEXT NOT NULL,
  line_start INT NOT NULL,
  line_end INT NOT NULL,
  chunk_text TEXT NOT NULL,
  embedding vector(768), -- nomic-embed-text-v1.5 (768 dimensions)
  chunk_hash TEXT NOT NULL,
  language TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, project_path, chunk_hash)
);

-- 3. Create index for fast vector cosine similarity search
CREATE INDEX IF NOT EXISTS idx_repo_embeddings_embedding 
  ON public.repo_embeddings USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- 4. Create compound index for fast incremental lookups & deletions
CREATE INDEX IF NOT EXISTS idx_repo_embeddings_lookup
  ON public.repo_embeddings (user_id, project_path, file_path);

CREATE INDEX IF NOT EXISTS idx_repo_embeddings_hash
  ON public.repo_embeddings (user_id, project_path, chunk_hash);

-- 5. Enable Row Level Security (RLS)
ALTER TABLE public.repo_embeddings ENABLE ROW LEVEL SECURITY;

-- 6. RLS Policies: strict user isolation
DROP POLICY IF EXISTS "Users can view own embeddings" ON public.repo_embeddings;
CREATE POLICY "Users can view own embeddings" 
  ON public.repo_embeddings FOR SELECT 
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own embeddings" ON public.repo_embeddings;
CREATE POLICY "Users can insert own embeddings" 
  ON public.repo_embeddings FOR INSERT 
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own embeddings" ON public.repo_embeddings;
CREATE POLICY "Users can update own embeddings" 
  ON public.repo_embeddings FOR UPDATE 
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete own embeddings" ON public.repo_embeddings;
CREATE POLICY "Users can delete own embeddings" 
  ON public.repo_embeddings FOR DELETE 
  USING (auth.uid() = user_id);

-- 7. RPC Function for similarity search
CREATE OR REPLACE FUNCTION match_repo_embeddings(
  p_user_id UUID,
  p_project_path TEXT,
  p_query_embedding vector(768),
  p_match_count INT DEFAULT 5
)
RETURNS TABLE (
  id UUID,
  file_path TEXT,
  line_start INT,
  line_end INT,
  chunk_text TEXT,
  similarity FLOAT
)
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
  RETURN QUERY
  SELECT
    re.id,
    re.file_path,
    re.line_start,
    re.line_end,
    re.chunk_text,
    (1 - (re.embedding <=> p_query_embedding))::FLOAT AS similarity
  FROM public.repo_embeddings re
  WHERE re.user_id = p_user_id
    AND re.project_path = p_project_path
    AND re.embedding IS NOT NULL
  ORDER BY re.embedding <=> p_query_embedding
  LIMIT p_match_count;
END;
$$;
