-- CRM schema for a NEW Supabase project.
-- Run once: Supabase dashboard > SQL Editor > New query > paste this file > Run.
-- Safe to re-run. Only the n8n workflows (service role key) access these tables.

create extension if not exists pgcrypto;

-- People who contact us.
create table if not exists public.contacts (
  id uuid primary key default gen_random_uuid(),
  first_name text,
  last_name text,
  email text,
  mobile text,
  suburb text,
  stream text not null default 'general',           -- buyer | tenant | seller_mandate | landlord_mandate | valuation | investor | general
  pipeline_stage text not null default 'New Enquiry',
  consent_general_at timestamptz,
  -- buyers
  sale_unit_type text,
  sale_development text,
  sale_buyer_profile text,
  sale_budget_max_zar numeric,
  sale_bond_status text,
  -- tenants
  rent_target_band_zar numeric,
  rent_move_in_date date,
  rent_household_size integer,
  rent_pets boolean,
  -- sellers, landlords, valuations
  mandate_property_address text,
  landlord_property_address text,
  val_property_address text,
  tags jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists uq_contacts_email on public.contacts (lower(email)) where email is not null;
create unique index if not exists uq_contacts_mobile on public.contacts (mobile) where mobile is not null;

-- Everything that happens: emails in and out, AI decisions, form submissions, opt-outs.
-- This is both the conversation history the agent reads and the audit trail of what it did.
create table if not exists public.events (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid references public.contacts(id) on delete cascade,
  event_type text not null,                         -- email_inbound | email_outbound | ai_triage | escalation_sent | opt_out | web_form
  channel text,
  direction text,                                   -- inbound | outbound | system
  payload jsonb not null default '{}'::jsonb,
  ai_verdict text,                                  -- send | escalate | optout | spam
  ai_latency_seconds integer,
  created_at timestamptz not null default now()
);
create index if not exists ix_events_contact on public.events (contact_id, created_at desc);
create index if not exists ix_events_type_time on public.events (event_type, created_at desc);
create index if not exists ix_events_message_id on public.events ((payload->>'message_id')) where event_type = 'email_inbound';

-- Opt-outs. Nobody on this list is contacted again.
create table if not exists public.suppression (
  id uuid primary key default gen_random_uuid(),
  contact text not null,
  contact_type text not null,                       -- email | phone
  reason text not null,
  source text,
  actor text,
  suppressed_at timestamptz not null default now(),
  unique (contact, contact_type)
);

-- Stock the AI may talk about. Only rows with status active, reduced or reserved
-- are shown to the AI. Staff edit this table; the agent picks up changes on the next email.
create table if not exists public.listings (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  unit_type text,
  address text,
  price_zar numeric,
  vat_inclusive boolean not null default false,
  levies_zar_pm numeric,
  sectional_title_scheme text,
  occupation_date date,
  body text,                                        -- plain description the AI quotes from
  status text not null default 'active',            -- active | reduced | reserved | sold | withdrawn
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.contacts enable row level security;
alter table public.events enable row level security;
alter table public.suppression enable row level security;
alter table public.listings enable row level security;
-- No policies: the public (anon) key can read nothing. The service role bypasses RLS.

-- Sample stock (the same fictional listings as evals/listings.json).
insert into public.listings (id, title, unit_type, address, price_zar, vat_inclusive, levies_zar_pm, sectional_title_scheme, body, status) values
  ('00000000-0000-4000-8000-000000000001', 'Unit Type A, Block 1, Milkwood Views', '2 Bed / 1 Bath Sectional Title Apartment',
   'Milkwood Views, Seaview, Port Haven', 695000, true, 320, 'Milkwood Views',
   'Two-bedroom, one-bathroom apartment (Unit Type A) in Block 1 of the Milkwood Views sectional title development in Seaview, Port Haven. 46 m2. Price includes VAT, no bond or transfer costs payable. Included: kitchen sink and cupboard. Levy R320/month. Occupation once the block is completed.',
   'active'),
  ('00000000-0000-4000-8000-000000000002', 'House Type A, Phase 2, Kingsmead Heights (Plot & Plan)', '2 Bed / 1 Bath Freehold House (Plot & Plan)',
   'Kingsmead Heights (Plot & Plan development), Seaview, Port Haven', 820000, true, 260, null,
   'Plot-and-plan 2-bedroom, 1-bathroom home (House Type A) in Phase 2 of Kingsmead Heights, Seaview, Port Haven. 45 m2 home on freehold stands of 140 to 240 m2. Price includes VAT, no bond or transfer costs payable. Included: gas hob, kitchen sink and cupboard, built-in bedroom cupboards. HOA levy R260/month; rates about R850/month. Occupation on completion of the build.',
   'active'),
  ('00000000-0000-4000-8000-000000000003', 'House Type B, Phase 4, Seaview Downs (Plot & Plan)', '2 Bed / 1 Bath Freehold House (Plot & Plan)',
   'Seaview Downs (Plot & Plan development), Seaview, Port Haven', 875000, true, 260, null,
   'Plot-and-plan 2-bedroom, 1-bathroom home (House Type B) in Phase 4 of Seaview Downs, Seaview, Port Haven. 54 m2 home on freehold stands of 150 to 330 m2. Price includes VAT, no bond or transfer costs payable. Included: gas hob, kitchen sink and cupboard, built-in bedroom cupboards. HOA levy R260/month; rates about R850/month. Occupation on completion of the build. Pets per HOA rules.',
   'active'),
  ('00000000-0000-4000-8000-000000000004', 'House Type C, Phase 5, The Quay (Plot & Plan)', '2 Bed / 2 Bath Freehold House (Plot & Plan)',
   'The Quay (Plot & Plan development), Riverbend, Port Haven', 990000, true, 260, null,
   'Plot-and-plan 2-bedroom, 2-bathroom home (House Type C) in Phase 5 of The Quay, Riverbend, Port Haven. 60 m2 home on freehold stands of 150 to 180 m2. Price includes VAT, no bond or transfer costs payable. Included: built-in cupboards, gas hob, enclosed backyard, driveway paving. HOA levy R260/month; rates about R1 050/month. Occupation on completion of the build. Pets allowed within HOA rules.',
   'active')
on conflict (id) do update set
  title = excluded.title, unit_type = excluded.unit_type, address = excluded.address, price_zar = excluded.price_zar,
  vat_inclusive = excluded.vat_inclusive, levies_zar_pm = excluded.levies_zar_pm, sectional_title_scheme = excluded.sectional_title_scheme,
  body = excluded.body, status = excluded.status, updated_at = now();

-- WhatsApp and phone calls: lookups by WhatsApp number and by message or call id.
create index if not exists ix_events_wa_id on public.events ((payload->>'wa_id'), created_at desc);
create index if not exists ix_events_any_message_id on public.events ((payload->>'message_id'));

-- Private bucket for the forms the agent sends on WhatsApp (Meta fetches them
-- through a signed link that works for an hour).
insert into storage.buckets (id, name, public) values ('agent-files', 'agent-files', false)
on conflict (id) do nothing;
