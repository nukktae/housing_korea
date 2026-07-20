-- Run this once in Supabase Dashboard → SQL Editor → New Query → Run.
-- Creates a public-readable, public-writable table for boyfriend's recommendations.

create table if not exists public.recommendations (
  listing_id text primary key,
  recommender text not null default 'boyfriend',
  recommended_at timestamptz not null default now()
);

alter table public.recommendations enable row level security;

drop policy if exists "anon read"   on public.recommendations;
drop policy if exists "anon write"  on public.recommendations;
drop policy if exists "anon delete" on public.recommendations;

create policy "anon read"   on public.recommendations for select  using (true);
create policy "anon write"  on public.recommendations for insert  with check (true);
create policy "anon delete" on public.recommendations for delete  using (true);
