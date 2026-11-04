import { useQuery } from '@tanstack/react-query';
import { unwrap } from '@openbots/api-client';
import { useMobile } from '../api/provider';
import { serverCompatibility } from '../api/compatibility';
import { Card, Label } from './ui';
export function ServerCompatibility() {
  const { client, transport } = useMobile();
  const result = useQuery({
    queryKey: ['capabilities'],
    enabled: Boolean(transport),
    staleTime: Infinity,
    queryFn: async () => {
      const result = await client!.GET('/api/v1/capabilities');
      if (result.response.status === 404) return null;
      return unwrap(Promise.resolve(result));
    },
  });
  if (serverCompatibility(result.data?.version) !== 'update') return null;
  return (
    <Card>
      <Label weight="600">Update your server</Label>
      <Label>This server is older than the version supported by this app.</Label>
    </Card>
  );
}
