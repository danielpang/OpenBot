import { useQuery } from '@tanstack/react-query';
import { useMobile } from './provider';
import { fileBytes } from './files';

export function useFileSource(fileId?: string) {
  const { host, transport } = useMobile();
  const result = useQuery({
    queryKey: ['file-image', host?.id, fileId],
    enabled: Boolean(transport && fileId),
    staleTime: Infinity,
    queryFn: async () => {
      const { bytes, mime } = await fileBytes(transport!, fileId!);
      // Do not render HTML/SVG supplied as an image through a WebView.
      if (!/^image\/(png|jpeg|webp|gif|heic|heif)(;|$)/i.test(mime))
        throw new Error('Unsupported image format');
      let binary = '';
      for (let offset = 0; offset < bytes.length; offset += 8192)
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
      return { uri: `data:${mime};base64,${btoa(binary)}` };
    },
  });
  return result.data;
}
