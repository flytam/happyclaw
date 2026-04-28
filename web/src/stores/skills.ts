import { create } from 'zustand';
import { api, apiFetch } from '../api/client';

export interface Skill {
  id: string;
  name: string;
  description: string;
  source: 'user' | 'project' | 'external';
  enabled: boolean;
  packageName?: string;
  installedAt?: string;
  userInvocable: boolean;
  allowedTools: string[];
  argumentHint: string | null;
  updatedAt: string;
  files: Array<{ name: string; type: 'file' | 'directory'; size: number }>;
}

export interface SkillDetail extends Skill {
  content: string;
}

export interface SearchResult {
  package: string;
  url: string;
  description?: string;
  installs?: number;
  skillId?: string;
  source?: string;
}

export interface SearchResultDetail {
  description: string;
  skillName?: string;
  readme?: string;
  installs: string;
  age: string;
  features: string[];
}

interface SkillsState {
  skills: Skill[];
  loading: boolean;
  error: string | null;
  installing: boolean;
  uploading: boolean;
  searching: boolean;
  searchResults: SearchResult[];
  searchDetails: Record<string, SearchResultDetail | null>;
  searchDetailLoading: Record<string, boolean>;

  loadSkills: () => Promise<void>;
  toggleSkill: (id: string, enabled: boolean) => Promise<void>;
  deleteSkill: (id: string) => Promise<void>;
  installSkill: (pkg: string) => Promise<void>;
  reinstallSkill: (id: string) => Promise<void>;
  uploadSkillZip: (file: File) => Promise<string[]>;
  uploadSkillFolder: (files: File[]) => Promise<string[]>;
  deleteAllUserSkills: () => Promise<number>;
  getSkillDetail: (id: string) => Promise<SkillDetail>;
  searchSkills: (query: string) => Promise<void>;
  fetchSearchDetail: (result: SearchResult) => Promise<void>;
}

export const useSkillsStore = create<SkillsState>((set, get) => ({
  skills: [],
  loading: false,
  error: null,
  installing: false,
  uploading: false,
  searching: false,
  searchResults: [],
  searchDetails: {},
  searchDetailLoading: {},

  loadSkills: async () => {
    set({ loading: true });
    try {
      const data = await api.get<{ skills: Skill[] }>('/api/skills');
      set({ skills: data.skills, loading: false, error: null });
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) });
    }
  },

  toggleSkill: async (id: string, enabled: boolean) => {
    try {
      await api.patch(`/api/skills/${id}`, { enabled });
      set({ error: null });
      await get().loadSkills();
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },

  deleteSkill: async (id: string) => {
    try {
      await api.delete(`/api/skills/${id}`);
      set({ error: null });
      await get().loadSkills();
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  },

  installSkill: async (pkg: string) => {
    set({ installing: true, error: null });
    try {
      await api.post('/api/skills/install', { package: pkg }, 60_000);
      await get().loadSkills();
    } catch (err: any) {
      set({ error: err?.message || (err instanceof Error ? err.message : '安装失败，请稍后重试') });
      throw err;
    } finally {
      set({ installing: false });
    }
  },

  reinstallSkill: async (id: string) => {
    set({ installing: true, error: null });
    try {
      await api.post(`/api/skills/${id}/reinstall`, {}, 60_000);
      await get().loadSkills();
    } catch (err: any) {
      set({ error: err?.message || '重新安装失败，请稍后重试' });
      throw err;
    } finally {
      set({ installing: false });
    }
  },

  uploadSkillZip: async (file: File) => {
    set({ uploading: true, error: null });
    try {
      const formData = new FormData();
      formData.append('file', file);
      const data = await apiFetch<{ success: boolean; installed: string[] }>(
        '/api/skills/upload',
        { method: 'POST', body: formData, headers: {}, timeoutMs: 120_000 },
      );
      await get().loadSkills();
      return data.installed;
    } catch (err: any) {
      const msg = err?.message || '上传失败，请稍后重试';
      set({ error: msg });
      throw err;
    } finally {
      set({ uploading: false });
    }
  },

  uploadSkillFolder: async (files: File[]) => {
    set({ uploading: true, error: null });
    try {
      const formData = new FormData();
      const paths: string[] = [];
      for (const file of files) {
        formData.append('files', file);
        paths.push((file as any).webkitRelativePath || file.name);
      }
      formData.append('paths', JSON.stringify(paths));
      const data = await apiFetch<{ success: boolean; installed: string[] }>(
        '/api/skills/upload',
        { method: 'POST', body: formData, headers: {}, timeoutMs: 120_000 },
      );
      await get().loadSkills();
      return data.installed;
    } catch (err: any) {
      const msg = err?.message || '上传失败，请稍后重试';
      set({ error: msg });
      throw err;
    } finally {
      set({ uploading: false });
    }
  },

  deleteAllUserSkills: async () => {
    const result = await api.delete<{ deleted: number }>('/api/skills/user-all');
    await get().loadSkills();
    return result.deleted;
  },

  getSkillDetail: async (id: string) => {
    const data = await api.get<{ skill: SkillDetail }>(`/api/skills/${id}`);
    return data.skill;
  },

  searchSkills: async (query: string) => {
    set({ searching: true, searchResults: [], searchDetails: {}, searchDetailLoading: {} });
    try {
      const data = await api.get<{ results: SearchResult[] }>(
        `/api/skills/search?q=${encodeURIComponent(query)}`,
      );
      set({ searching: false, searchResults: data.results });
    } catch {
      set({ searching: false, searchResults: [] });
    }
  },

  fetchSearchDetail: async (result: SearchResult) => {
    const key = result.package;
    const { searchDetails, searchDetailLoading } = get();
    if (key in searchDetails || searchDetailLoading[key]) return;

    set({ searchDetailLoading: { ...get().searchDetailLoading, [key]: true } });
    try {
      // Use source/skillId params if available (new API), fallback to url
      const params = result.source && result.skillId
        ? `source=${encodeURIComponent(result.source)}&skillId=${encodeURIComponent(result.skillId)}`
        : result.url
          ? `url=${encodeURIComponent(result.url)}`
          : '';

      if (!params) {
        set({
          searchDetails: { ...get().searchDetails, [key]: null },
          searchDetailLoading: { ...get().searchDetailLoading, [key]: false },
        });
        return;
      }

      const data = await api.get<{ detail: SearchResultDetail | null }>(
        `/api/skills/search/detail?${params}`,
      );
      set({
        searchDetails: { ...get().searchDetails, [key]: data.detail },
        searchDetailLoading: { ...get().searchDetailLoading, [key]: false },
      });
    } catch {
      set({
        searchDetails: { ...get().searchDetails, [key]: null },
        searchDetailLoading: { ...get().searchDetailLoading, [key]: false },
      });
    }
  },
}));
