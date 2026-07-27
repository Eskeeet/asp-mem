\set ON_ERROR_STOP on

insert into auth.users (id)
values ('2a487e8e-4b2a-4737-8f70-e2b0d73b68da')
on conflict do nothing;

do $$
declare
  v_owner uuid := '2a487e8e-4b2a-4737-8f70-e2b0d73b68da';
  v_first uuid := '11111111-1111-4111-8111-111111111111';
  v_second uuid := '22222222-2222-4222-8222-222222222222';
  v_third uuid := '44444444-4444-4444-8444-444444444444';
  v_existing uuid := '55555555-5555-4555-8555-555555555555';
  v_duplicate_source uuid := '66666666-6666-4666-8666-666666666666';
  v_result jsonb;
  v_count bigint;
  v_score double precision;
begin
  v_result := public.remember_asp_memory_v2(
    jsonb_build_object(
      'id', v_first,
      'ownerId', v_owner,
      'scope', jsonb_build_object('userId', v_owner::text, 'agentId', 'agent-a'),
      'kind', 'preference',
      'content', 'Prefers tea',
      'importance', 0.6,
      'confidence', 0.7,
      'metadata', '{}'::jsonb,
      'links', '[]'::jsonb,
      'observedAt', '2025-01-01T00:00:00Z',
      'validFrom', '2025-01-01T00:00:00Z',
      'createdAt', '2025-01-01T00:00:00Z'
    ),
    0.1
  );
  assert (v_result->>'created')::boolean, 'first memory was not created';

  v_result := public.remember_asp_memory_v2(
    jsonb_build_object(
      'id', '33333333-3333-4333-8333-333333333333',
      'ownerId', v_owner,
      'scope', jsonb_build_object('userId', v_owner::text, 'agentId', 'agent-a'),
      'kind', 'preference',
      'content', '  prefers  tea ',
      'importance', 0.2,
      'confidence', 0.2,
      'metadata', '{}'::jsonb,
      'links', '[]'::jsonb,
      'observedAt', '2025-01-01T00:00:00Z',
      'createdAt', '2025-02-01T00:00:00Z'
    ),
    0.1
  );
  assert not (v_result->>'created')::boolean, 'duplicate was inserted';
  assert abs((v_result->'memory'->>'confidence')::double precision - 0.8) < 1e-10,
    'duplicate did not reinforce confidence';
  assert (v_result->'memory'->>'importance')::double precision = 0.6,
    'duplicate mutated importance';

  select count(*) into v_count
  from public.list_asp_memories_v2(
    v_owner,
    jsonb_build_object('userId', v_owner::text, 'agentId', 'agent-a'),
    10, '2025-06-01', null, false, false, null, null, null
  );
  assert v_count = 1, 'scoped list failed';

  select matched.score into v_score
  from public.match_asp_memories_v2(
    v_owner,
    jsonb_build_object('userId', v_owner::text, 'agentId', 'agent-a'),
    'tea preference', null,
    '{"semantic":0.5,"keyword":0.2,"importance":0.1,"recency":0.05,"temporal":0.1,"access":0.05}'::jsonb,
    10, '2025-06-01', null, false, false, -1, -1, null, null, null
  ) as matched
  limit 1;
  assert v_score > 0, 'lexical hybrid search failed';

  v_result := public.supersede_asp_memory_v2(
    v_owner,
    jsonb_build_object('userId', v_owner::text, 'agentId', 'agent-a'),
    v_first,
    jsonb_build_object(
      'id', v_second,
      'ownerId', v_owner,
      'scope', jsonb_build_object('userId', v_owner::text, 'agentId', 'agent-a'),
      'kind', 'preference',
      'content', 'Prefers coffee',
      'importance', 0.6,
      'confidence', 0.9,
      'metadata', '{}'::jsonb,
      'links', jsonb_build_array(jsonb_build_object('memoryId', v_first, 'type', 'updates')),
      'supersedesId', v_first,
      'observedAt', '2026-01-01T00:00:00Z',
      'validFrom', '2025-09-01T00:00:00Z',
      'createdAt', '2026-01-01T00:00:00Z'
    ),
    '2026-01-01T00:00:00Z', null, 'changed preference'
  );
  assert v_result->'previous'->>'status' = 'superseded', 'old memory stayed active';
  assert (v_result->'previous'->>'valid_until')::timestamptz =
    '2025-09-01T00:00:00Z'::timestamptz,
    'old validity did not end when the replacement became true';
  assert v_result->'replacement'->>'content' = 'Prefers coffee', 'replacement missing';

  select count(*) into v_count
  from public.history_asp_memory_v2(
    v_owner,
    jsonb_build_object('userId', v_owner::text, 'agentId', 'agent-a'),
    v_first
  );
  assert v_count = 3, 'history is incomplete';

  v_result := public.supersede_asp_memory_v2(
    v_owner,
    jsonb_build_object('userId', v_owner::text, 'agentId', 'agent-a'),
    v_second,
    jsonb_build_object(
      'id', v_third,
      'ownerId', v_owner,
      'scope', jsonb_build_object('userId', v_owner::text, 'agentId', 'agent-a'),
      'kind', 'preference',
      'content', 'Prefers tea',
      'importance', 0.6,
      'confidence', 0.9,
      'metadata', '{}'::jsonb,
      'links', jsonb_build_array(jsonb_build_object('memoryId', v_second, 'type', 'updates')),
      'supersedesId', v_second,
      'observedAt', '2027-01-01T00:00:00Z',
      'validFrom', '2027-01-01T00:00:00Z',
      'createdAt', '2027-01-01T00:00:00Z'
    ),
    '2027-01-01T00:00:00Z', null, 'changed preference back'
  );
  assert v_result->'previous'->>'status' = 'superseded',
    'second memory stayed active';
  assert v_result->'replacement'->>'content' = 'Prefers tea',
    'historical content could not become active again';

  perform public.record_asp_memory_access_v2(array[v_third], '2027-01-02');
  assert (select access_count from public.asp_memories where id = v_third) = 1,
    'access stats were not recorded';

  perform public.remember_asp_memory_v2(
    jsonb_build_object(
      'id', v_existing,
      'ownerId', v_owner,
      'scope', jsonb_build_object('userId', v_owner::text, 'agentId', 'agent-a'),
      'kind', 'preference',
      'content', 'Enjoys hiking',
      'importance', 0.6,
      'confidence', 0.7,
      'metadata', '{}'::jsonb,
      'links', '[]'::jsonb,
      'observedAt', '2027-02-01T00:00:00Z',
      'createdAt', '2027-02-01T00:00:00Z'
    ),
    0.1
  );
  perform public.remember_asp_memory_v2(
    jsonb_build_object(
      'id', v_duplicate_source,
      'ownerId', v_owner,
      'scope', jsonb_build_object('userId', v_owner::text, 'agentId', 'agent-a'),
      'kind', 'preference',
      'content', 'Likes trails',
      'importance', 0.6,
      'confidence', 0.7,
      'metadata', '{}'::jsonb,
      'links', '[]'::jsonb,
      'observedAt', '2027-02-01T00:00:00Z',
      'createdAt', '2027-02-01T00:00:00Z'
    ),
    0.1
  );
  v_result := public.supersede_asp_memory_v2(
    v_owner,
    jsonb_build_object('userId', v_owner::text, 'agentId', 'agent-a'),
    v_duplicate_source,
    jsonb_build_object(
      'id', '77777777-7777-4777-8777-777777777777',
      'ownerId', v_owner,
      'scope', jsonb_build_object('userId', v_owner::text, 'agentId', 'agent-a'),
      'kind', 'preference',
      'content', 'Enjoys hiking',
      'importance', 0.6,
      'confidence', 0.9,
      'metadata', '{}'::jsonb,
      'links', jsonb_build_array(
        jsonb_build_object('memoryId', v_duplicate_source, 'type', 'updates')
      ),
      'supersedesId', v_duplicate_source,
      'observedAt', '2027-03-01T00:00:00Z',
      'validFrom', '2027-03-01T00:00:00Z',
      'createdAt', '2027-03-01T00:00:00Z'
    ),
    '2027-03-01T00:00:00Z', null, 'deduplicated replacement'
  );
  assert (v_result->'replacement'->>'id')::uuid = v_existing,
    'supersession did not reuse the active replacement';
  assert v_result->'replacement'->'links' @> jsonb_build_array(
    jsonb_build_object('memoryId', v_duplicate_source, 'type', 'updates')
  ), 'deduplicated replacement lost its provenance link';

  v_count := public.forget_asp_memories_v2(
    v_owner,
    jsonb_build_object('userId', v_owner::text),
    array[v_first], null, null, null
  );
  assert v_count = 1, 'owner scope did not delete a descendant-scoped memory';
  assert (select supersedes_id from public.asp_memories where id = v_second) is null,
    'deleting an old observation left a blocking provenance foreign key';

  v_count := public.forget_asp_memories_v2(
    v_owner,
    jsonb_build_object('userId', v_owner::text),
    null, null, null, null
  );
  assert v_count = 4, 'owner-wide forget did not remove remaining descendants';
end;
$$;
