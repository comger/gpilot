package db

import (
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

var DB *gorm.DB

// Init 初始化数据库连接并自动迁移
func Init(path string) error {
	var err error
	DB, err = gorm.Open(sqlite.Open(path), &gorm.Config{
		Logger: logger.Default.LogMode(logger.Warn),
	})
	if err != nil {
		return err
	}

	// 自动迁移所有表
	return DB.AutoMigrate(
		&Project{},
		&Session{},
		&RecordingStep{},
		&Screenshot{},
		&MaskingProfile{},
		&MaskingRule{},
		&GeneratedDocument{},
		&LLMProvider{},
	)
}
