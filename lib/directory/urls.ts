import { DIRECTORY_LIST_RESOURCE } from '@/lib/directory/paidResources';
import { USDC_DIRECTORY_LIST } from '@/lib/directory/usdcResource';
import { LEGAL_ENTITY } from '@/lib/legal';

export const DIRECTORY_LIST_API_URL = `${LEGAL_ENTITY.siteUrl}${DIRECTORY_LIST_RESOURCE.path}`;
export const DIRECTORY_USDC_LIST_API_URL = `${LEGAL_ENTITY.siteUrl}${USDC_DIRECTORY_LIST.path}`;
export const DIRECTORY_OPENAPI_PATH = '/api/openapi.json';
