-- asp-mem v0.2: temporal observations, provenance history, scoped access,
-- bounded access decay, hybrid lexical/vector retrieval, and hard-purge policy.
-- Apply after 001_asp_mem.sql. Keep vector(768) aligned with migration 001.

alter table public.asp_memories
  add column if not exists scope_tenant_id text,
  add column if not exists scope_organization_id text,
  add column if not exists scope_user_id text,
  add column if not exists scope_agent_id text,
  add column if not exists scope_session_id text,
  add column if not exists confidence double precision not null default 0.7,
  add column if not exists status text not null default 'active',
  add column if not exists attributed_to text,
  add column if not exists source_uri text,
  add column if not exists source_checksum text,
  add column if not exists metadata jsonb not null default '{}'::jsonb,
  add column if not exists links jsonb not null default '[]'::jsonb,
  add column if not exists supersedes_id uuid references public.asp_memories(id),
  add column if not exists embedding_model text,
  add column if not exists observed_at timestamptz,
  add column if not exists valid_from timestamptz,
  add column if not exists valid_until timestamptz,
  add column if not exists visible_until timestamptz,
  add column if not exists purge_at timestamptz,
  add column if not exists access_count bigint not null default 0,
  add column if not exists last_accessed_at timestamptz,
  add column if not exists recent_accesses timestamptz[] not null default '{}'::timestamptz[];

update public.asp_memories
set
  scope_user_id = coalesce(scope_user_id, owner_id::text),
  observed_at = coalesce(observed_at, created_at),
  visible_until = coalesce(visible_until, expires_at)
where scope_user_id is null
   or observed_at is null
   or (visible_until is null and expires_at is not null);

alter table public.asp_memories
  alter column observed_at set default now(),
  alter column observed_at set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'asp_memories_confidence_check'
      and conrelid = 'public.asp_memories'::regclass
  ) then
    alter table public.asp_memories
      add constraint asp_memories_confidence_check
      check (confidence between 0 and 1);
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'asp_memories_status_check'
      and conrelid = 'public.asp_memories'::regclass
  ) then
    alter table public.asp_memories
      add constraint asp_memories_status_check
      check (status in ('active', 'superseded', 'retracted'));
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'asp_memories_attribution_check'
      and conrelid = 'public.asp_memories'::regclass
  ) then
    alter table public.asp_memories
      add constraint asp_memories_attribution_check
      check (attributed_to is null or attributed_to in ('user', 'assistant', 'tool', 'system'));
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'asp_memories_valid_interval_check'
      and conrelid = 'public.asp_memories'::regclass
  ) then
    alter table public.asp_memories
      add constraint asp_memories_valid_interval_check
      check (valid_until is null or valid_from is null or valid_until > valid_from);
  end if;
end;
$$;

alter table public.asp_memories
  add column if not exists scope_key text generated always as (
    coalesce(scope_tenant_id, '') || chr(1) ||
    coalesce(scope_organization_id, '') || chr(1) ||
    coalesce(scope_user_id, '') || chr(1) ||
    coalesce(scope_agent_id, '') || chr(1) ||
    coalesce(scope_session_id, '')
  ) stored,
  add column if not exists search_vector tsvector generated always as (
    to_tsvector('simple', coalesce(content, ''))
  ) stored;

alter table public.asp_memories
  drop constraint if exists asp_memories_owner_id_kind_content_key_key;

drop index if exists public.asp_memories_scoped_content_key;
create unique index if not exists asp_memories_active_scoped_content_key
  on public.asp_memories (owner_id, scope_key, kind, content_key)
  where status = 'active';

create index if not exists asp_memories_scope_rank_idx
  on public.asp_memories (
    owner_id, scope_user_id, scope_agent_id, scope_session_id,
    status, importance desc, created_at desc
  );

create index if not exists asp_memories_search_idx
  on public.asp_memories using gin (search_vector);

create index if not exists asp_memories_temporal_idx
  on public.asp_memories (owner_id, valid_from, valid_until, visible_until);

alter table public.asp_memories
  drop constraint if exists asp_memories_supersedes_id_fkey;
alter table public.asp_memories
  add constraint asp_memories_supersedes_id_fkey
  foreign key (supersedes_id) references public.asp_memories(id) on delete set null;

create table if not exists public.asp_memory_events (
  id uuid primary key default gen_random_uuid(),
  memory_id uuid not null references public.asp_memories(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  action text not null check (
    action in ('add', 'reinforce', 'revise', 'supersede', 'retract', 'restore')
  ),
  previous_snapshot jsonb,
  next_snapshot jsonb,
  actor_id text,
  actor_roles text[],
  reason text,
  created_at timestamptz not null default now()
);

create index if not exists asp_memory_events_memory_time_idx
  on public.asp_memory_events (memory_id, created_at);

alter table public.asp_memory_events enable row level security;

drop policy if exists "Owners can read asp memory events" on public.asp_memory_events;
create policy "Owners can read asp memory events"
  on public.asp_memory_events for select
  using (auth.uid() = owner_id);

drop policy if exists "Owners can insert asp memory events" on public.asp_memory_events;
create policy "Owners can insert asp memory events"
  on public.asp_memory_events for insert
  with check (auth.uid() = owner_id);

drop policy if exists "Owners can delete asp memory events" on public.asp_memory_events;
create policy "Owners can delete asp memory events"
  on public.asp_memory_events for delete
  using (auth.uid() = owner_id);

create or replace function public.asp_memory_scope_matches(
  p_tenant text,
  p_organization text,
  p_user text,
  p_agent text,
  p_session text,
  p_scope jsonb
) returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select
    (p_tenant is null or p_tenant = p_scope->>'tenantId')
    and (p_organization is null or p_organization = p_scope->>'organizationId')
    and (p_user is null or p_user = p_scope->>'userId')
    and (p_agent is null or p_agent = p_scope->>'agentId')
    and (p_session is null or p_session = p_scope->>'sessionId');
$$;

create or replace function public.asp_memory_is_visible(
  p_status text,
  p_observed_at timestamptz,
  p_valid_from timestamptz,
  p_valid_until timestamptz,
  p_visible_until timestamptz,
  p_now timestamptz,
  p_reference_time timestamptz,
  p_include_expired boolean,
  p_include_inactive boolean
) returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select
    (p_include_expired or p_visible_until is null or p_visible_until > p_now)
    and (
      p_include_inactive
      or (
        p_status <> 'retracted'
        and coalesce(p_valid_from, p_observed_at) <= coalesce(p_reference_time, p_now)
        and (p_valid_until is null or p_valid_until > coalesce(p_reference_time, p_now))
        and (p_status = 'active' or p_reference_time is not null)
      )
    );
$$;

create or replace function public.asp_memory_scope_within(
  p_tenant text,
  p_organization text,
  p_user text,
  p_agent text,
  p_session text,
  p_scope jsonb
) returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select
    (p_scope->>'tenantId' is null or p_tenant = p_scope->>'tenantId')
    and (p_scope->>'organizationId' is null or p_organization = p_scope->>'organizationId')
    and (p_scope->>'userId' is null or p_user = p_scope->>'userId')
    and (p_scope->>'agentId' is null or p_agent = p_scope->>'agentId')
    and (p_scope->>'sessionId' is null or p_session = p_scope->>'sessionId');
$$;

create or replace function public.remember_asp_memory_v2(
  p_memory jsonb,
  p_duplicate_confidence_boost double precision
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_owner_id uuid := (p_memory->>'ownerId')::uuid;
  v_scope jsonb := coalesce(p_memory->'scope', '{}'::jsonb);
  v_scope_key text;
  v_existing public.asp_memories%rowtype;
  v_previous jsonb;
  v_memory public.asp_memories%rowtype;
  v_created boolean := false;
begin
  v_scope_key :=
    coalesce(v_scope->>'tenantId', '') || chr(1) ||
    coalesce(v_scope->>'organizationId', '') || chr(1) ||
    coalesce(v_scope->>'userId', v_owner_id::text) || chr(1) ||
    coalesce(v_scope->>'agentId', '') || chr(1) ||
    coalesce(v_scope->>'sessionId', '');

  perform pg_advisory_xact_lock(hashtextextended(
    v_owner_id::text || chr(1) || v_scope_key || chr(1) ||
    coalesce(p_memory->>'kind', '') || chr(1) ||
    lower(regexp_replace(trim(p_memory->>'content'), '\s+', ' ', 'g')),
    0
  ));

  select * into v_existing
  from public.asp_memories
  where owner_id = v_owner_id
    and scope_key = v_scope_key
    and kind = p_memory->>'kind'
    and content_key = lower(regexp_replace(trim(p_memory->>'content'), '\s+', ' ', 'g'))
    and status = 'active'
  for update;

  if found then
    v_previous := to_jsonb(v_existing);
    update public.asp_memories
    set
      confidence = least(1, confidence + greatest(0, p_duplicate_confidence_boost)),
      embedding = coalesce(
        embedding,
        case when p_memory->'embedding' is null or p_memory->'embedding' = 'null'::jsonb
          then null else (p_memory->'embedding')::text::public.vector(768) end
      ),
      embedding_model = coalesce(embedding_model, p_memory->>'embeddingModel'),
      updated_at = coalesce((p_memory->>'createdAt')::timestamptz, now())
    where id = v_existing.id
    returning * into v_memory;

    insert into public.asp_memory_events (
      memory_id, owner_id, action, previous_snapshot, next_snapshot,
      actor_id, actor_roles, created_at
    ) values (
      v_memory.id, v_owner_id, 'reinforce', v_previous, to_jsonb(v_memory),
      p_memory->'actor'->>'id',
      case when jsonb_typeof(p_memory->'actor'->'roles') = 'array'
        then array(select jsonb_array_elements_text(p_memory->'actor'->'roles')) else null end,
      coalesce((p_memory->>'createdAt')::timestamptz, now())
    );
  else
    insert into public.asp_memories (
      id, owner_id,
      scope_tenant_id, scope_organization_id, scope_user_id,
      scope_agent_id, scope_session_id,
      kind, content, importance, confidence, status, attributed_to,
      source_type, source_id, source_uri, source_checksum,
      metadata, links, supersedes_id, embedding, embedding_model,
      observed_at, valid_from, valid_until, visible_until, expires_at,
      purge_at, created_at, updated_at
    ) values (
      (p_memory->>'id')::uuid,
      v_owner_id,
      v_scope->>'tenantId',
      v_scope->>'organizationId',
      coalesce(v_scope->>'userId', v_owner_id::text),
      v_scope->>'agentId',
      v_scope->>'sessionId',
      p_memory->>'kind',
      trim(regexp_replace(p_memory->>'content', '\s+', ' ', 'g')),
      greatest(0, least(1, coalesce((p_memory->>'importance')::double precision, 0.5))),
      greatest(0, least(1, coalesce((p_memory->>'confidence')::double precision, 0.7))),
      'active',
      p_memory->>'attributedTo',
      p_memory->'source'->>'type',
      p_memory->'source'->>'id',
      p_memory->'source'->>'uri',
      p_memory->'source'->>'checksum',
      coalesce(p_memory->'metadata', '{}'::jsonb),
      coalesce(p_memory->'links', '[]'::jsonb),
      nullif(p_memory->>'supersedesId', '')::uuid,
      case when p_memory->'embedding' is null or p_memory->'embedding' = 'null'::jsonb
        then null else (p_memory->'embedding')::text::public.vector(768) end,
      p_memory->>'embeddingModel',
      coalesce((p_memory->>'observedAt')::timestamptz, now()),
      nullif(p_memory->>'validFrom', '')::timestamptz,
      nullif(p_memory->>'validUntil', '')::timestamptz,
      nullif(p_memory->>'visibleUntil', '')::timestamptz,
      nullif(p_memory->>'visibleUntil', '')::timestamptz,
      nullif(p_memory->>'purgeAt', '')::timestamptz,
      coalesce((p_memory->>'createdAt')::timestamptz, now()),
      coalesce((p_memory->>'createdAt')::timestamptz, now())
    ) returning * into v_memory;
    v_created := true;

    insert into public.asp_memory_events (
      memory_id, owner_id, action, next_snapshot,
      actor_id, actor_roles, created_at
    ) values (
      v_memory.id, v_owner_id, 'add', to_jsonb(v_memory),
      p_memory->'actor'->>'id',
      case when jsonb_typeof(p_memory->'actor'->'roles') = 'array'
        then array(select jsonb_array_elements_text(p_memory->'actor'->'roles')) else null end,
      v_memory.created_at
    );
  end if;

  return jsonb_build_object('memory', to_jsonb(v_memory), 'created', v_created);
end;
$$;

create or replace function public.get_asp_memory_v2(
  p_owner_id uuid,
  p_scope jsonb,
  p_memory_id uuid
) returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select to_jsonb(memory)
  from public.asp_memories as memory
  where memory.id = p_memory_id
    and memory.owner_id = p_owner_id
    and public.asp_memory_scope_matches(
      memory.scope_tenant_id, memory.scope_organization_id, memory.scope_user_id,
      memory.scope_agent_id, memory.scope_session_id, p_scope
    );
$$;

create or replace function public.list_asp_memories_v2(
  p_owner_id uuid,
  p_scope jsonb,
  p_match_count integer,
  p_now timestamptz,
  p_reference_time timestamptz,
  p_include_expired boolean,
  p_include_inactive boolean,
  p_kinds text[],
  p_source_type text,
  p_source_id text
) returns setof public.asp_memories
language sql
stable
security invoker
set search_path = ''
as $$
  select memory.*
  from public.asp_memories as memory
  where memory.owner_id = p_owner_id
    and public.asp_memory_scope_matches(
      memory.scope_tenant_id, memory.scope_organization_id, memory.scope_user_id,
      memory.scope_agent_id, memory.scope_session_id, p_scope
    )
    and public.asp_memory_is_visible(
      memory.status, memory.observed_at, memory.valid_from, memory.valid_until,
      memory.visible_until, p_now, p_reference_time,
      p_include_expired, p_include_inactive
    )
    and (p_kinds is null or memory.kind = any(p_kinds))
    and (p_source_type is null or memory.source_type = p_source_type)
    and (p_source_id is null or memory.source_id = p_source_id)
  order by memory.importance desc, memory.created_at desc
  limit greatest(1, least(500, p_match_count));
$$;

create or replace function public.match_asp_memories_v2(
  p_owner_id uuid,
  p_scope jsonb,
  p_query_text text,
  p_query_embedding public.vector(768),
  p_weights jsonb,
  p_match_count integer,
  p_now timestamptz,
  p_reference_time timestamptz,
  p_include_expired boolean,
  p_include_inactive boolean,
  p_min_similarity double precision,
  p_min_score double precision,
  p_kinds text[],
  p_source_type text,
  p_source_id text
) returns table (
  memory jsonb,
  similarity double precision,
  score double precision,
  score_details jsonb
)
language sql
stable
security invoker
set search_path = ''
as $$
  with candidates as (
    select
      item.*,
      case when p_query_embedding is null or item.embedding is null then null
        else 1 - (item.embedding operator(public.<=>) p_query_embedding) end as raw_similarity,
      ts_rank_cd(item.search_vector, plainto_tsquery('simple', coalesce(p_query_text, ''))) as raw_keyword
    from public.asp_memories as item
    where item.owner_id = p_owner_id
      and public.asp_memory_scope_matches(
        item.scope_tenant_id, item.scope_organization_id, item.scope_user_id,
        item.scope_agent_id, item.scope_session_id, p_scope
      )
      and public.asp_memory_is_visible(
        item.status, item.observed_at, item.valid_from, item.valid_until,
        item.visible_until, p_now, p_reference_time,
        p_include_expired, p_include_inactive
      )
      and (p_kinds is null or item.kind = any(p_kinds))
      and (p_source_type is null or item.source_type = p_source_type)
      and (p_source_id is null or item.source_id = p_source_id)
  ), normalized as (
    select
      candidates.*,
      case when raw_similarity is null then 0 else greatest(0, least(1, (raw_similarity + 1) / 2)) end as semantic_score,
      case when max(raw_keyword) over () = 0 then 0
        else raw_keyword / max(raw_keyword) over () end as keyword_score,
      greatest(0, least(1, importance)) as importance_score,
      power(2, -greatest(0, extract(epoch from (p_now - updated_at)) / 86400) / 90) as recency_score,
      case when p_reference_time is null then
        case when valid_from is not null or valid_until is not null then 0.75 else 0.5 end
        when coalesce(valid_from, observed_at) <= p_reference_time
          and (valid_until is null or valid_until > p_reference_time) then 1
        else power(2, -least(
          abs(extract(epoch from (p_reference_time - coalesce(valid_from, observed_at)))) / 86400,
          coalesce(abs(extract(epoch from (p_reference_time - valid_until))) / 86400, 1e12)
        ) / 30) end as temporal_score,
      greatest(0, least(1,
        ((greatest(0.3, least(1.5,
          case when last_accessed_at is null or access_count = 0 then 0.7
          else 0.3
            + 0.7 * power(2, -greatest(0, extract(epoch from (p_now - last_accessed_at)) / 86400) / 30)
            + 0.5 * (1 - exp(-access_count::double precision / 6)) end
        ))) - 0.3) / 1.2
      )) as access_score
    from candidates
    where raw_similarity is null or raw_similarity >= p_min_similarity
  ), weighted as (
    select
      normalized.*,
      (case when raw_similarity is null then 0 else coalesce((p_weights->>'semantic')::double precision, 0.5) end)
        + (case when length(trim(coalesce(p_query_text, ''))) = 0 then 0 else coalesce((p_weights->>'keyword')::double precision, 0.2) end)
        + coalesce((p_weights->>'importance')::double precision, 0.1)
        + coalesce((p_weights->>'recency')::double precision, 0.05)
        + coalesce((p_weights->>'temporal')::double precision, 0.1)
        + coalesce((p_weights->>'access')::double precision, 0.05) as weight_total,
      (semantic_score * case when raw_similarity is null then 0 else coalesce((p_weights->>'semantic')::double precision, 0.5) end)
        + (keyword_score * case when length(trim(coalesce(p_query_text, ''))) = 0 then 0 else coalesce((p_weights->>'keyword')::double precision, 0.2) end)
        + importance_score * coalesce((p_weights->>'importance')::double precision, 0.1)
        + recency_score * coalesce((p_weights->>'recency')::double precision, 0.05)
        + temporal_score * coalesce((p_weights->>'temporal')::double precision, 0.1)
        + access_score * coalesce((p_weights->>'access')::double precision, 0.05) as weighted_sum
    from normalized
  ), scored as (
    select weighted.*, case when weight_total = 0 then 0 else weighted_sum / weight_total end as fused_score
    from weighted
  )
  select
    to_jsonb(scored) - array[
      'raw_similarity', 'raw_keyword', 'semantic_score', 'keyword_score',
      'importance_score', 'recency_score', 'temporal_score', 'access_score',
      'weight_total', 'weighted_sum', 'fused_score'
    ],
    raw_similarity,
    fused_score,
    jsonb_build_object(
      'semantic', semantic_score,
      'keyword', keyword_score,
      'importance', importance_score,
      'recency', recency_score,
      'temporal', temporal_score,
      'access', access_score,
      'accessFactor', access_score * 1.2 + 0.3,
      'activeWeights', jsonb_strip_nulls(jsonb_build_object(
        'semantic', case when raw_similarity is null then null
          else coalesce((p_weights->>'semantic')::double precision, 0.5) end,
        'keyword', case when length(trim(coalesce(p_query_text, ''))) = 0 then null
          else coalesce((p_weights->>'keyword')::double precision, 0.2) end,
        'importance', coalesce((p_weights->>'importance')::double precision, 0.1),
        'recency', coalesce((p_weights->>'recency')::double precision, 0.05),
        'temporal', coalesce((p_weights->>'temporal')::double precision, 0.1),
        'access', coalesce((p_weights->>'access')::double precision, 0.05)
      )),
      'fused', fused_score
    )
  from scored
  where fused_score >= p_min_score
  order by fused_score desc, importance desc, created_at desc
  limit greatest(1, least(500, p_match_count));
$$;

create or replace function public.revise_asp_memory_v2(
  p_owner_id uuid,
  p_scope jsonb,
  p_memory_id uuid,
  p_patch jsonb,
  p_at timestamptz,
  p_actor jsonb,
  p_reason text
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_previous public.asp_memories%rowtype;
  v_next public.asp_memories%rowtype;
  v_action text := 'revise';
begin
  select * into v_previous
  from public.asp_memories as memory
  where memory.id = p_memory_id
    and memory.owner_id = p_owner_id
    and public.asp_memory_scope_matches(
      memory.scope_tenant_id, memory.scope_organization_id, memory.scope_user_id,
      memory.scope_agent_id, memory.scope_session_id, p_scope
    )
  for update;
  if not found then raise exception 'Memory not found: %', p_memory_id; end if;

  update public.asp_memories
  set
    content = case when p_patch ? 'content'
      then trim(regexp_replace(p_patch->>'content', '\s+', ' ', 'g')) else content end,
    kind = case when p_patch ? 'kind' then p_patch->>'kind' else kind end,
    importance = case when p_patch ? 'importance'
      then greatest(0, least(1, (p_patch->>'importance')::double precision)) else importance end,
    confidence = case when p_patch ? 'confidence'
      then greatest(0, least(1, (p_patch->>'confidence')::double precision)) else confidence end,
    status = case when p_patch ? 'status' then p_patch->>'status' else status end,
    attributed_to = case when p_patch ? 'attributedTo' then p_patch->>'attributedTo' else attributed_to end,
    source_type = case when p_patch ? 'source' then p_patch->'source'->>'type' else source_type end,
    source_id = case when p_patch ? 'source' then p_patch->'source'->>'id' else source_id end,
    source_uri = case when p_patch ? 'source' then p_patch->'source'->>'uri' else source_uri end,
    source_checksum = case when p_patch ? 'source' then p_patch->'source'->>'checksum' else source_checksum end,
    metadata = case when p_patch ? 'metadata' then coalesce(p_patch->'metadata', '{}'::jsonb) else metadata end,
    links = case when p_patch ? 'links' then coalesce(p_patch->'links', '[]'::jsonb) else links end,
    embedding = case when p_patch ? 'embedding' then
      case when p_patch->'embedding' = 'null'::jsonb then null
        else (p_patch->'embedding')::text::public.vector(768) end else embedding end,
    embedding_model = case when p_patch ? 'embeddingModel' then p_patch->>'embeddingModel' else embedding_model end,
    observed_at = case when p_patch ? 'observedAt' then (p_patch->>'observedAt')::timestamptz else observed_at end,
    valid_from = case when p_patch ? 'validFrom' then (p_patch->>'validFrom')::timestamptz else valid_from end,
    valid_until = case when p_patch ? 'validUntil' then (p_patch->>'validUntil')::timestamptz else valid_until end,
    visible_until = case when p_patch ? 'visibleUntil' then (p_patch->>'visibleUntil')::timestamptz else visible_until end,
    expires_at = case when p_patch ? 'visibleUntil' then (p_patch->>'visibleUntil')::timestamptz else expires_at end,
    purge_at = case when p_patch ? 'purgeAt' then (p_patch->>'purgeAt')::timestamptz else purge_at end,
    updated_at = p_at
  where id = p_memory_id
  returning * into v_next;

  if v_next.status = 'retracted' then v_action := 'retract';
  elsif v_next.status = 'superseded' then v_action := 'supersede';
  elsif v_previous.status = 'retracted' and v_next.status = 'active' then v_action := 'restore';
  end if;

  insert into public.asp_memory_events (
    memory_id, owner_id, action, previous_snapshot, next_snapshot,
    actor_id, actor_roles, reason, created_at
  ) values (
    p_memory_id, p_owner_id, v_action, to_jsonb(v_previous), to_jsonb(v_next),
    p_actor->>'id',
    case when jsonb_typeof(p_actor->'roles') = 'array'
      then array(select jsonb_array_elements_text(p_actor->'roles')) else null end,
    p_reason, p_at
  );
  return to_jsonb(v_next);
end;
$$;

create or replace function public.supersede_asp_memory_v2(
  p_owner_id uuid,
  p_scope jsonb,
  p_memory_id uuid,
  p_replacement jsonb,
  p_at timestamptz,
  p_actor jsonb,
  p_reason text
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_current jsonb;
  v_previous jsonb;
  v_created jsonb;
  v_replacement jsonb;
begin
  v_current := public.get_asp_memory_v2(p_owner_id, p_scope, p_memory_id);
  if v_current is null then
    raise exception 'Memory not found: %', p_memory_id;
  end if;
  if v_current->>'status' <> 'active' then
    raise exception 'Only active memories can be superseded: %', p_memory_id;
  end if;
  v_previous := public.revise_asp_memory_v2(
    p_owner_id, p_scope, p_memory_id,
    jsonb_build_object('status', 'superseded', 'validUntil', p_at),
    p_at, p_actor, p_reason
  );
  v_created := public.remember_asp_memory_v2(p_replacement, 0);
  v_replacement := v_created->'memory';
  if not (v_created->>'created')::boolean then
    v_replacement := public.revise_asp_memory_v2(
      p_owner_id, p_scope, (v_replacement->>'id')::uuid,
      jsonb_build_object(
        'links',
        coalesce(v_replacement->'links', '[]'::jsonb) ||
          jsonb_build_array(
            jsonb_build_object('memoryId', p_memory_id, 'type', 'updates')
          )
      ),
      p_at, p_actor, coalesce(p_reason, 'supersede')
    );
  end if;
  return jsonb_build_object(
    'previous', v_previous,
    'replacement', v_replacement
  );
end;
$$;

create or replace function public.history_asp_memory_v2(
  p_owner_id uuid,
  p_scope jsonb,
  p_memory_id uuid
) returns setof public.asp_memory_events
language sql
stable
security invoker
set search_path = ''
as $$
  select event.*
  from public.asp_memory_events as event
  join public.asp_memories as memory on memory.id = event.memory_id
  where event.owner_id = p_owner_id
    and event.memory_id = p_memory_id
    and public.asp_memory_scope_matches(
      memory.scope_tenant_id, memory.scope_organization_id, memory.scope_user_id,
      memory.scope_agent_id, memory.scope_session_id, p_scope
    )
  order by event.created_at, event.id;
$$;

create or replace function public.record_asp_memory_access_v2(
  p_ids uuid[],
  p_at timestamptz
) returns void
language sql
security invoker
set search_path = ''
as $$
  update public.asp_memories
  set
    access_count = access_count + 1,
    last_accessed_at = p_at,
    recent_accesses = (recent_accesses || p_at)[greatest(1, array_length(recent_accesses || p_at, 1) - 19):]
  where id = any(p_ids);
$$;

create or replace function public.cleanup_asp_memories_v2(
  p_owner_id uuid,
  p_scope jsonb,
  p_now timestamptz,
  p_weak_importance double precision,
  p_weak_before timestamptz
) returns bigint
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_count bigint;
begin
  delete from public.asp_memories as memory
  where memory.owner_id = p_owner_id
    and public.asp_memory_scope_within(
      memory.scope_tenant_id, memory.scope_organization_id, memory.scope_user_id,
      memory.scope_agent_id, memory.scope_session_id, p_scope
    )
    and (
      (memory.purge_at is not null and memory.purge_at <= p_now)
      or (memory.importance < p_weak_importance and memory.created_at < p_weak_before)
    );
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create or replace function public.forget_asp_memories_v2(
  p_owner_id uuid,
  p_scope jsonb,
  p_ids uuid[],
  p_kinds text[],
  p_source_type text,
  p_source_id text
) returns bigint
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_count bigint;
begin
  delete from public.asp_memories as memory
  where memory.owner_id = p_owner_id
    and public.asp_memory_scope_within(
      memory.scope_tenant_id, memory.scope_organization_id, memory.scope_user_id,
      memory.scope_agent_id, memory.scope_session_id, p_scope
    )
    and (p_ids is null or memory.id = any(p_ids))
    and (p_kinds is null or memory.kind = any(p_kinds))
    and (p_source_type is null or memory.source_type = p_source_type)
    and (p_source_id is null or memory.source_id = p_source_id);
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- The v0.1 boost function mutated importance. v0.2 retrieval uses bounded access
-- statistics instead, so new adapters never call boost_asp_memories.
