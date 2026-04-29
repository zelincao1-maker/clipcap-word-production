do $$
begin
  alter type public.generation_task_item_status add value if not exists 'ocr_running';
exception
  when duplicate_object then null;
end;
$$;

do $$
begin
  alter type public.generation_task_item_status add value if not exists 'ocr_completed';
exception
  when duplicate_object then null;
end;
$$;

do $$
begin
  alter type public.generation_task_item_status add value if not exists 'slot_filling';
exception
  when duplicate_object then null;
end;
$$;
