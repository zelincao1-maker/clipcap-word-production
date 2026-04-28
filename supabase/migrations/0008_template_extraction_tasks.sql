do $$
begin
  create type public.template_extraction_task_status as enum (
    'pending',
    'running',
    'completed',
    'failed'
  );
exception
  when duplicate_object then null;
end;
$$;

create table if not exists public.template_extraction_tasks (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  source_docx_name text not null,
  source_docx_base64 text not null,
  prompt text not null default '',
  status public.template_extraction_task_status not null default 'pending',
  total_paragraphs integer not null default 0,
  completed_paragraphs integer not null default 0,
  upload_text text,
  upload_html text,
  result jsonb,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);

create index if not exists template_extraction_tasks_owner_created_idx
  on public.template_extraction_tasks(owner_id, created_at desc);

create index if not exists template_extraction_tasks_status_created_idx
  on public.template_extraction_tasks(status, created_at desc);

alter table public.template_extraction_tasks enable row level security;

drop policy if exists template_extraction_tasks_select_own on public.template_extraction_tasks;
create policy template_extraction_tasks_select_own
on public.template_extraction_tasks for select
using (owner_id = auth.uid() or public.is_admin(auth.uid()));

drop policy if exists template_extraction_tasks_insert_own on public.template_extraction_tasks;
create policy template_extraction_tasks_insert_own
on public.template_extraction_tasks for insert
with check (owner_id = auth.uid() or public.is_admin(auth.uid()));

drop policy if exists template_extraction_tasks_update_own on public.template_extraction_tasks;
create policy template_extraction_tasks_update_own
on public.template_extraction_tasks for update
using (owner_id = auth.uid() or public.is_admin(auth.uid()))
with check (owner_id = auth.uid() or public.is_admin(auth.uid()));

drop policy if exists template_extraction_tasks_delete_own on public.template_extraction_tasks;
create policy template_extraction_tasks_delete_own
on public.template_extraction_tasks for delete
using (owner_id = auth.uid() or public.is_admin(auth.uid()));
