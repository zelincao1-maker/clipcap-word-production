alter table public.generation_task_items
  add column if not exists slot_total_count int not null default 0;

alter table public.generation_task_items
  add column if not exists slot_completed_count int not null default 0;
