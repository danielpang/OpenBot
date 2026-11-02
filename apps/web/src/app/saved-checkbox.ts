import { useMutation } from '@tanstack/react-query';
import { useEffect, useState, type ChangeEvent } from 'react';

/**
 * A checkbox saved as soon as it changes. Until the save settles it shows the
 * value just picked rather than the saved one, so the click registers at once
 * instead of after the server answers; if the save fails it shows the saved
 * value again, beside the error. After a successful save it keeps the pick
 * until the saved value (read back by `onSuccess`, for example an
 * invalidation's refetch) agrees with it. Spread the result, less `error`,
 * onto the input.
 */
export function useSavedCheckbox<T>(
  saved: boolean,
  mutationFn: (on: boolean) => Promise<T>,
  onSuccess: (data: T) => Promise<unknown>,
) {
  const [picked, setPicked] = useState<boolean | null>(null);
  // A failed save shows the saved value again at once. A successful one keeps
  // showing the pick until the saved value catches up, so the box never flicks
  // back while the read back (or a slow or failed refetch) is still on its way.
  const save = useMutation({ mutationFn, onSuccess, onError: () => setPicked(null) });
  useEffect(() => {
    if (picked !== null && !save.isPending && saved === picked) setPicked(null);
  }, [picked, saved, save.isPending]);
  return {
    checked: picked ?? saved,
    disabled: save.isPending,
    error: save.error,
    onChange(event: ChangeEvent<HTMLInputElement>) {
      const on = event.currentTarget.checked;
      setPicked(on);
      save.mutate(on);
    },
  };
}
