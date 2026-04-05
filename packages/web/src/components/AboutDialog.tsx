import { Dialog } from '@/components/ui/Dialog';
import { i18n } from '@/i18n';

interface AboutDialogProps {
  open: boolean;
  onClose: () => void;
}

export function AboutDialog({ open, onClose }: AboutDialogProps) {
  const { t } = i18n;
  return (
    <Dialog open={open} onClose={onClose} title={t('aboutTitle')}>
      <div>
        <p>{t('aboutDescription')}</p>
        <p>
          <a href="https://github.com/billstark001/labby" target="_blank" rel="noopener noreferrer">
            github.com/billstark001/labby
          </a>
        </p>
      </div>
    </Dialog>
  );
}
