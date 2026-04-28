alter table public.generation_task_items
  add column if not exists processing_trace text not null default '';

create or replace function public.append_generation_task_item_processing_trace(
  p_task_item_id uuid,
  p_entry text
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  next_trace text;
begin
  update public.generation_task_items
  set
    processing_trace = case
      when coalesce(processing_trace, '') = '' then p_entry
      else processing_trace || E'\n' || p_entry
    end,
    updated_at = now()
  where id = p_task_item_id
  returning processing_trace into next_trace;

  return coalesce(next_trace, '');
end;
$$;
