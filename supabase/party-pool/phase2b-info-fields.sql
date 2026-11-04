-- Applied as migration "party_pool_info_fields". Adds important party info fields and returns them from party_public.
alter table public.parties
  add column inclusions text not null default '' check (char_length(inclusions) <= 2000),
  add column dress_code text not null default '' check (char_length(dress_code) <= 300),
  add column min_age integer not null default 21 check (min_age between 18 and 25),
  add column highlights text not null default '' check (char_length(highlights) <= 2000);
-- party_public(uuid) was dropped and recreated with four extra output columns at the end
-- (inclusions, dress_code, min_age, highlights); body otherwise identical to phase 2, grants: anon + authenticated, none to public.
