-- asp-mem reference schema for Supabase + pgvector.
--
-- Embeddings are 768-dimensional by default. Change every vector(768)
-- occurrence if your embedding provider uses another size before applying.

create extension if not exists vector;

create table if not exists public.asp_memories (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  kind text not null,
  content text not null check (length(trim(content)) > 0),
  content_key text generated always as (
    lower(regexp_replace(trim(content), '\s+', ' ', 'g'))
  ) stored,
  importance double precision not null default 0.5
    check (importance between 0 and 1),
  source_type text,
  source_id text,
  embedding vector(768),
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, kind, content_key)
);

create index if not exists asp_memories_owner_rank_idx
  on public.asp_memories (owner_id, importance desc, created_at desc);

create index if not exists asp_memories_source_idx
  on public.asp_memories (owner_id, source_type, source_id);

create index if not exists asp_memories_embedding_idx
  on public.asp_memories
  using hnsw (embedding vector_cosine_ops)
  where embedding is not null;

alter table public.asp_memories enable row level security;

drop policy if exists "Owners can read asp memories" on public.asp_memories;
create policy "Owners can read asp memories"
  on public.asp_memories for select
  using (auth.uid() = owner_id);

drop policy if exists "Owners can insert asp memories" on public.asp_memories;
create policy "Owners can insert asp memories"
  on public.asp_memories for insert
  with check (auth.uid() = owner_id);

drop policy if exists "Owners can update asp memories" on public.asp_memories;
create policy "Owners can update asp memories"
  on public.asp_memories for update
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);

drop policy if exists "Owners can delete asp memories" on public.asp_memories;
create policy "Owners can delete asp memories"
  on public.asp_memories for delete
  using (auth.uid() = owner_id);

create or replace function public.remember_asp_memory(
  p_id uuid,
  p_owner_id uuid,
  p_kind text,
  p_content text,
  p_importance double precision,
  p_source_type text,
  p_source_id text,
  p_embedding vector(768),
  p_expires_at timestamptz,
  p_duplicate_boost double precision
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  result jsonb;
begin
  with upserted as (
    insert into public.asp_memories as existing (
      id, owner_id, kind, content, importance, source_type, source_id,
      embedding, expires_at
    ) values (
      p_id,
      p_owner_id,
      p_kind,
      trim(regexp_replace(p_content, '\s+', ' ', 'g')),
      greatest(0, least(1, p_importance)),
      p_source_type,
      p_source_id,
      p_embedding,
      p_expires_at
    )
    on conflict (owner_id, kind, content_key) do update set
      importance = least(
        1,
        existing.importance + greatest(0, p_duplicate_boost)
      ),
      embedding = coalesce(existing.embedding, excluded.embedding),
      expires_at = coalesce(excluded.expires_at, existing.expires_at),
      updated_at = now()
    returning to_jsonb(existing.*) as memory, (xmax = 0) as created
  )
  select jsonb_build_object('memory', memory, 'created', created)
    into result
    from upserted;

  return result;
end;
$$;

create or replace function public.match_asp_memories(
  p_owner_id uuid,
  p_query_embedding vector(768),
  p_match_count integer,
  p_importance_weight double precision,
  p_min_similarity double precision,
  p_kinds text[],
  p_source_type text,
  p_source_id text
) returns table (
  id uuid,
  owner_id uuid,
  kind text,
  content text,
  importance double precision,
  source_type text,
  source_id text,
  embedding vector(768),
  expires_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz,
  similarity double precision,
  score double precision
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    memory.id,
    memory.owner_id,
    memory.kind,
    memory.content,
    memory.importance,
    memory.source_type,
    memory.source_id,
    memory.embedding,
    memory.expires_at,
    memory.created_at,
    memory.updated_at,
    1 - (memory.embedding operator(public.<=>) p_query_embedding) as similarity,
    (1 - (memory.embedding operator(public.<=>) p_query_embedding))
      * (1 - greatest(0, least(1, p_importance_weight)))
      + memory.importance * greatest(0, least(1, p_importance_weight)) as score
  from public.asp_memories as memory
  where memory.owner_id = p_owner_id
    and memory.embedding is not null
    and (memory.expires_at is null or memory.expires_at > now())
    and (p_kinds is null or memory.kind = any(p_kinds))
    and (p_source_type is null or memory.source_type = p_source_type)
    and (p_source_id is null or memory.source_id = p_source_id)
    and 1 - (memory.embedding operator(public.<=>) p_query_embedding) >= p_min_similarity
  order by score desc, memory.created_at desc
  limit greatest(1, least(100, p_match_count));
$$;

create or replace function public.boost_asp_memories(
  p_ids uuid[],
  p_amount double precision
) returns void
language sql
security invoker
set search_path = ''
as $$
  update public.asp_memories
  set
    importance = least(1, importance + greatest(0, p_amount)),
    updated_at = now()
  where id = any(p_ids);
$$;

create or replace function public.cleanup_asp_memories(
  p_owner_id uuid,
  p_now timestamptz,
  p_weak_importance double precision,
  p_weak_before timestamptz
) returns bigint
language plpgsql
security invoker
set search_path = ''
as $$
declare
  deleted_count bigint;
begin
  delete from public.asp_memories
  where owner_id = p_owner_id
    and (
      (expires_at is not null and expires_at <= p_now)
      or (importance < p_weak_importance and created_at < p_weak_before)
    );
  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;
