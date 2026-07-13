import { DIRECTORY_LIST_RESOURCE } from '@/lib/directory/paidResources';
import { LEGAL_ENTITY } from '@/lib/legal';

export const DIRECTORY_LIST_API_URL = `${LEGAL_ENTITY.siteUrl}${DIRECTORY_LIST_RESOURCE.path}`;
export const DIRECTORY_SEARCH_API_URL = `${DIRECTORY_LIST_API_URL}/search`;
export const DIRECTORY_OPENAPI_PATH = '/api/openapi.json';
