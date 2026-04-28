import { useState, useRef, useCallback } from 'react';
import { Loader2, Search, ExternalLink, Download, ChevronDown, ChevronUp, Upload, FolderUp, FileArchive } from 'lucide-react';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useSkillsStore, type SearchResult } from '@/stores/skills';
import { MarkdownRenderer } from '../chat/MarkdownRenderer';

interface InstallSkillDialogProps {
  open: boolean;
  onClose: () => void;
  onInstall: (pkg: string) => Promise<void>;
  installing: boolean;
}

type Tab = 'search' | 'manual' | 'upload';

function formatInstalls(n?: number): string {
  if (n === undefined || n === null) return '';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function SearchResultItem({
  result,
  isInstalling,
  installingPkg,
  onInstall,
}: {
  result: SearchResult;
  isInstalling: boolean;
  installingPkg: string | null;
  onInstall: (result: SearchResult) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const { searchDetails, searchDetailLoading, fetchSearchDetail } = useSkillsStore();

  const key = result.package;
  const detail = searchDetails[key];
  const loading = searchDetailLoading[key];

  const handleToggle = () => {
    if (!expanded && !(key in searchDetails)) {
      fetchSearchDetail(result);
    }
    setExpanded(!expanded);
  };

  const installCount = formatInstalls(result.installs);

  return (
    <div className="rounded-lg border border-border hover:bg-muted/50 transition-colors overflow-hidden">
      <div className="flex items-center justify-between p-3">
        <button
          type="button"
          className="min-w-0 flex-1 text-left flex items-center gap-2"
          onClick={handleToggle}
        >
          {expanded
            ? <ChevronUp className="size-3.5 shrink-0 text-muted-foreground" />
            : <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />}
          <div className="min-w-0 flex-1">
            <span className="text-sm font-medium text-foreground truncate block">
              {result.package}
            </span>
            {installCount && (
              <span className="text-xs text-muted-foreground">
                {installCount} 次安装
              </span>
            )}
          </div>
        </button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => onInstall(result)}
          disabled={isInstalling}
          className="ml-3 shrink-0"
        >
          {installingPkg === result.package ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Download className="size-3.5" />
          )}
          <span className="ml-1">安装</span>
        </Button>
      </div>

      {expanded && (
        <div className="px-3 pb-3 pt-0 border-t border-border/50">
          {loading && (
            <div className="flex items-center gap-2 py-3 text-muted-foreground text-xs">
              <Loader2 className="size-3 animate-spin" />
              加载详情...
            </div>
          )}

          {!loading && detail && (
            <div className="space-y-2 pt-2">
              {detail.description && (
                <p className="text-xs text-foreground/80 leading-relaxed">{detail.description}</p>
              )}

              {detail.readme && (
                <div className="mt-2 border border-border/50 rounded-md p-3 max-h-64 overflow-y-auto bg-muted/30">
                  <MarkdownRenderer content={detail.readme} variant="docs" />
                </div>
              )}

              {!detail.readme && detail.features && detail.features.length > 0 && (
                <ul className="space-y-0.5">
                  {detail.features.map((f, i) => (
                    <li key={i} className="text-xs text-muted-foreground flex gap-1.5">
                      <span className="text-primary/60 shrink-0">-</span>
                      <span>{f}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {!loading && detail === null && (
            <p className="text-xs text-muted-foreground py-2">无法加载详情</p>
          )}

          {result.url && (
            <a
              href={result.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-muted-foreground hover:text-primary inline-flex items-center gap-1 mt-2"
            >
              在 skills.sh 查看
              <ExternalLink className="size-3" />
            </a>
          )}
        </div>
      )}
    </div>
  );
}

export function InstallSkillDialog({
  open,
  onClose,
  onInstall,
  installing,
}: InstallSkillDialogProps) {
  const [tab, setTab] = useState<Tab>('search');
  const [pkg, setPkg] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [installingPkg, setInstallingPkg] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const zipInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  const { searching, searchResults, searchSkills, uploading, uploadSkillZip, uploadSkillFolder } = useSkillsStore();

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = searchQuery.trim();
    if (!trimmed) return;
    await searchSkills(trimmed);
  };

  const handleInstallFromSearch = async (result: SearchResult) => {
    try {
      setInstallingPkg(result.package);
      await onInstall(result.package);
      setInstallingPkg(null);
      onClose();
    } catch (err) {
      setInstallingPkg(null);
      toast.error(err instanceof Error ? err.message : '安装失败');
    }
  };

  const handleManualSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = pkg.trim();
    if (!trimmed) {
      toast.error('请输入技能包名称');
      return;
    }

    try {
      await onInstall(trimmed);
      setPkg('');
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '安装失败');
    }
  };

  const handleZipUpload = useCallback(async (file: File) => {
    if (!file.name.endsWith('.zip')) {
      toast.error('请选择 .zip 文件');
      return;
    }
    try {
      const installed = await uploadSkillZip(file);
      toast.success(`已安装 ${installed.length} 个技能: ${installed.join(', ')}`);
      onClose();
    } catch (err: any) {
      toast.error(err?.message || '上传失败');
    }
  }, [uploadSkillZip, onClose]);

  const handleFolderUpload = useCallback(async (files: File[]) => {
    if (files.length === 0) return;
    try {
      const installed = await uploadSkillFolder(files);
      toast.success(`已安装 ${installed.length} 个技能: ${installed.join(', ')}`);
      onClose();
    } catch (err: any) {
      toast.error(err?.message || '上传失败');
    }
  }, [uploadSkillFolder, onClose]);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const items = e.dataTransfer.files;
    if (items.length === 1 && items[0].name.endsWith('.zip')) {
      await handleZipUpload(items[0]);
    } else {
      toast.error('请拖拽一个 .zip 文件');
    }
  }, [handleZipUpload]);

  const handleClose = () => {
    if (!installing && !uploading) {
      setPkg('');
      setSearchQuery('');
      setInstallingPkg(null);
      setDragOver(false);
      onClose();
    }
  };

  const isInstalling = installing || !!installingPkg;

  return (
    <Dialog open={open} onOpenChange={(v) => !v && handleClose()}>
      <DialogContent className="sm:max-w-lg max-h-[80vh] flex flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>安装技能</DialogTitle>
        </DialogHeader>

        {/* Tabs */}
        <div className="flex border-b border-border shrink-0">
          <button
            type="button"
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              tab === 'search'
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
            onClick={() => { setTab('search'); }}
            disabled={isInstalling || uploading}
          >
            <Search className="size-3.5 inline-block mr-1.5 -mt-0.5" />
            搜索市场
          </button>
          <button
            type="button"
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              tab === 'upload'
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
            onClick={() => { setTab('upload'); }}
            disabled={isInstalling || uploading}
          >
            <Upload className="size-3.5 inline-block mr-1.5 -mt-0.5" />
            本地上传
          </button>
          <button
            type="button"
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              tab === 'manual'
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
            onClick={() => { setTab('manual'); }}
            disabled={isInstalling || uploading}
          >
            手动安装
          </button>
        </div>

        {/* Search Tab */}
        {tab === 'search' && (
          <div className="space-y-3 min-h-0 flex flex-col overflow-hidden">
            <form onSubmit={handleSearch} className="flex gap-2 shrink-0">
              <Input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="搜索关键词..."
                disabled={searching || isInstalling}
                className="flex-1"
              />
              <Button
                type="submit"
                variant="outline"
                disabled={searching || isInstalling || !searchQuery.trim()}
              >
                {searching ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}
              </Button>
            </form>

            {/* Results */}
            <div className="overflow-y-auto space-y-2 min-h-0 flex-1">
              {searching && (
                <div className="flex items-center justify-center py-8 text-muted-foreground">
                  <Loader2 className="size-4 animate-spin mr-2" />
                  搜索中...
                </div>
              )}

              {!searching && searchResults.length === 0 && searchQuery.trim() && (
                <div className="text-center py-8 text-muted-foreground text-sm">
                  未找到相关技能
                </div>
              )}

              {!searching && searchResults.map((result) => (
                <SearchResultItem
                  key={result.package}
                  result={result}
                  isInstalling={isInstalling}
                  installingPkg={installingPkg}
                  onInstall={handleInstallFromSearch}
                />
              ))}
            </div>

            {!searching && searchResults.length === 0 && !searchQuery.trim() && (
              <p className="text-xs text-muted-foreground text-center py-4">
                在 skills.sh 市场中搜索可用的技能包
              </p>
            )}
          </div>
        )}

        {/* Upload Tab */}
        {tab === 'upload' && (
          <div className="space-y-4">
            {/* Drop zone for zip */}
            <div
              className={`border-2 border-dashed rounded-lg p-6 text-center transition-colors ${
                dragOver
                  ? 'border-primary bg-primary/5'
                  : 'border-border hover:border-muted-foreground/50'
              } ${uploading ? 'opacity-50 pointer-events-none' : 'cursor-pointer'}`}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleDrop}
              onClick={() => !uploading && zipInputRef.current?.click()}
            >
              {uploading ? (
                <div className="flex flex-col items-center gap-2">
                  <Loader2 className="size-8 text-primary animate-spin" />
                  <p className="text-sm text-muted-foreground">正在上传并安装...</p>
                </div>
              ) : (
                <div className="flex flex-col items-center gap-2">
                  <FileArchive className="size-8 text-muted-foreground" />
                  <p className="text-sm text-foreground font-medium">拖拽 .zip 文件到此处，或点击选择</p>
                  <p className="text-xs text-muted-foreground">
                    zip 内应包含 skill-name/SKILL.md 结构
                  </p>
                </div>
              )}
            </div>

            <input
              ref={zipInputRef}
              type="file"
              accept=".zip"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handleZipUpload(file);
                e.target.value = '';
              }}
            />

            {/* Folder upload */}
            <div className="flex items-center gap-3">
              <div className="flex-1 border-t border-border" />
              <span className="text-xs text-muted-foreground">或</span>
              <div className="flex-1 border-t border-border" />
            </div>

            <Button
              variant="outline"
              className="w-full"
              disabled={uploading}
              onClick={() => folderInputRef.current?.click()}
            >
              <FolderUp className="size-4 mr-2" />
              选择文件夹上传
            </Button>

            <input
              ref={folderInputRef}
              type="file"
              className="hidden"
              {...{ webkitdirectory: '', directory: '' } as any}
              onChange={(e) => {
                const files = e.target.files;
                if (files && files.length > 0) {
                  handleFolderUpload(Array.from(files));
                }
                e.target.value = '';
              }}
            />

            <p className="text-xs text-muted-foreground leading-relaxed">
              文件夹应包含 SKILL.md 文件。支持单技能目录或包含多个子技能的父目录。
            </p>
          </div>
        )}

        {/* Manual Tab */}
        {tab === 'manual' && (
          <form onSubmit={handleManualSubmit} className="space-y-4">
            <div>
              <label htmlFor="skill-pkg" className="block text-sm font-medium text-foreground mb-2">
                技能包名称
              </label>
              <Input
                id="skill-pkg"
                type="text"
                value={pkg}
                onChange={(e) => setPkg(e.target.value)}
                placeholder="owner/repo、owner/repo@skill 或 GitHub URL"
                disabled={isInstalling}
              />
              <p className="mt-1 text-xs text-muted-foreground">
                支持格式：owner/repo、owner/repo@skill 或 GitHub URL
              </p>
            </div>

            <div className="flex items-center justify-end gap-3 pt-2">
              <Button
                type="button"
                variant="ghost"
                onClick={handleClose}
                disabled={isInstalling}
              >
                取消
              </Button>
              <Button
                type="submit"
                disabled={isInstalling || !pkg.trim()}
              >
                {isInstalling && <Loader2 className="size-4 animate-spin" />}
                安装
              </Button>
            </div>
          </form>
        )}

      </DialogContent>
    </Dialog>
  );
}
