-- Run this in your Supabase SQL editor

create table if not exists profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade unique not null,
  budget numeric default 150,
  dietary text[] default '{}',
  allergies text[] default '{}',
  brands text[] default '{}',
  instacart_email text default '',
  instacart_password text default '',
  created_at timestamptz default now()
);

create table if not exists grocery_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade not null,
  name text not null,
  quantity text default '1',
  notes text default '',
  cleared boolean default false,
  added_at timestamptz default now()
);

create table if not exists schedules (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade unique not null,
  days integer[] default '{0}',
  time text default '09:00',
  reminder_enabled boolean default true,
  reminder_hours_before integer default 1,
  active boolean default true,
  created_at timestamptz default now()
);

create table if not exists carts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade not null,
  status text default 'pending' check (status in ('pending', 'reviewed', 'checked_out')),
  total numeric default 0,
  platform text default 'instacart',
  created_at timestamptz default now()
);

create table if not exists cart_items (
  id uuid primary key default gen_random_uuid(),
  cart_id uuid references carts(id) on delete cascade not null,
  grocery_item_name text not null,
  product_name text not null,
  price numeric default 0,
  image_url text default '',
  product_url text default '',
  store text default '',
  swapped boolean default false
);

-- Row Level Security
alter table profiles enable row level security;
alter table grocery_items enable row level security;
alter table schedules enable row level security;
alter table carts enable row level security;
alter table cart_items enable row level security;

create policy "Users manage own profile" on profiles for all using (auth.uid() = user_id);
create policy "Users manage own items" on grocery_items for all using (auth.uid() = user_id);
create policy "Users manage own schedule" on schedules for all using (auth.uid() = user_id);
create policy "Users manage own carts" on carts for all using (auth.uid() = user_id);
create policy "Users manage own cart items" on cart_items for all
  using (cart_id in (select id from carts where user_id = auth.uid()));
